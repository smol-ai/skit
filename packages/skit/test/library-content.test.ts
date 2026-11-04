import { SourceProcess } from "../src/platform/source-process.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join, sep } from "node:path";
import { Library } from "../src/library/library.js";
import { libraryManifestFromLocalState } from "../src/library/library-state.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";
import { acquireFileLock } from "../src/platform/file-lock.js";
import { collectionVersionPath } from "../src/library/collection-version.js";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "skit-content-owner-" }),
  );
  const home = join(root, "library");
  return yield* Effect.gen(function* () {
    const library = yield* Library.Service;
    for (const name of ["review", "test"]) {
      const source = join(root, name);
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(
        join(source, "SKILL.md"),
        `---\nname: ${name}\ndescription: Content fixture\n---\nExact ${name} bytes.\n`,
      );
      const request = yield* localImportRequest(source, "2026-11-04T00:00:00.000Z");
      if (Option.isNone(request)) return yield* Effect.die("Expected a Skill source");
      yield* library.import.collection(request.value);
    }
    const snapshot = yield* library.read;
    if (snapshot._tag === "Absent") return yield* Effect.die("Imported Library is absent");
    const manifest = yield* libraryManifestFromLocalState(snapshot.state);
    const archives = yield* library.content.pack(snapshot);
    return { fs, root, home, library, snapshot, manifest, archives };
  }).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));
});
const registry = { origin: "https://registry.example", token: Option.none<string>() };

it.effect(
  "owner content reads are passive, pack verified bytes and refuse changed retained content",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const state = yield* f.fs.readFileString(join(f.home, "state.json"));
      assert.deepStrictEqual(yield* f.library.content.inspect(f.snapshot), { _tag: "Intact" });
      assert.strictEqual(f.archives.length, 2);
      assert.strictEqual(yield* f.fs.readFileString(join(f.home, "state.json")), state);
      const tree = f.manifest.collection_versions[0];
      yield* f.fs.writeFileString(
        join(collectionVersionPath(join(f.home, "originals"), tree.hash), "SKILL.md"),
        "changed\n",
      );
      assert.deepStrictEqual(yield* f.library.content.inspect(f.snapshot), {
        _tag: "Changed",
        hash: tree.hash,
      });
      const refused = yield* Effect.result(f.library.content.pack(f.snapshot));
      assert.strictEqual(refused._tag, "Failure");
      if (refused._tag === "Failure")
        assert.strictEqual(refused.failure._tag, "InvalidLibraryState");
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "staging preserves download requirements, fetches without a writer and publishes bytes without state",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const home = join(f.root, "fresh");
      const callbackProcess = { ...(yield* SourceProcess) };
      let publications = 0;
      yield* f.fs.makeDirectory(home);
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const availability = yield* library.content.plan(f.manifest, []);
        assert.strictEqual(availability.download.length, 2);
        let downloads = 0;
        const download = (hash: (typeof f.archives)[number]["digest"]) =>
          Effect.gen(function* () {
            // The transport is caller-owned and must retain its own required service.
            assert.strictEqual(yield* SourceProcess, callbackProcess);
            assert.isTrue(
              yield* Effect.isSuccess(Effect.scoped(acquireFileLock(join(home, "lock.sqlite")))),
            );
            downloads++;
            const archive = f.archives.find((candidate) => candidate.digest === hash);
            if (archive === undefined) return yield* Effect.die("Unexpected download hash");
            return archive;
          });
        const staged = yield* library.content
          .stage(f.manifest, { localArchives: [], registry, download })
          .pipe(Effect.provideService(SourceProcess, callbackProcess));
        assert.strictEqual(downloads, 2);
        assert.strictEqual(publications, 2);
        assert.strictEqual(staged.retained.length, 2);
        assert.deepStrictEqual(staged.missing, []);
        assert.strictEqual((yield* library.read)._tag, "Absent");
        assert.deepStrictEqual((yield* library.history).events, []);
        assert.isFalse(yield* f.fs.exists(join(home, "state.json")));
        for (const archive of f.archives)
          assert.isTrue(
            yield* f.fs.exists(collectionVersionPath(join(home, "originals"), archive.digest)),
          );
        const repeat = yield* library.content.stage(
          {
            ...f.manifest,
            collections: [...f.manifest.collections].reverse(),
            skills: [...f.manifest.skills].reverse(),
            collection_versions: [...f.manifest.collection_versions].reverse(),
            imports: [...f.manifest.imports].reverse(),
            snapshot_digests: [...f.manifest.snapshot_digests].reverse(),
          },
          { localArchives: f.archives, registry },
        );
        assert.strictEqual(repeat.manifestDigest, staged.manifestDigest);
        assert.strictEqual(repeat.reusable.length, 2);
        assert.deepStrictEqual(repeat.retained, []);
        const reviewed = yield* library.content.plan(f.manifest, []);
        yield* f.fs.remove(collectionVersionPath(join(home, "originals"), f.archives[0].digest), {
          recursive: true,
        });
        const disappeared = yield* Effect.result(
          library.content.stage(f.manifest, {
            plan: reviewed,
            registry,
            download: () => {
              downloads++;
              return Effect.fail("unreviewed-download" as const);
            },
          }),
        );
        assert.strictEqual(disappeared._tag, "Failure");
        if (disappeared._tag === "Failure") {
          if (typeof disappeared.failure === "string")
            return yield* Effect.die("Staging added an unreviewed download");
          assert.strictEqual(disappeared.failure._tag, "Library.RestoreInvalid");
        }
        assert.strictEqual(downloads, 2);
        assert.strictEqual(publications, 2);
      }).pipe(
        Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              if (to.startsWith(join(home, "originals") + sep)) {
                assert.isFalse(
                  yield* Effect.isSuccess(
                    Effect.scoped(acquireFileLock(join(home, "lock.sqlite"))),
                  ),
                );
                publications++;
              }
              yield* f.fs.rename(from, to);
            }),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "missing content and typed download failures do not create state or publish partial bytes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const home = join(f.root, "missing");
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const future = { ...f.manifest, future: { keep: "unsupported data" } };
        const unsupported = yield* Effect.result(
          library.content.stage(future, { localArchives: f.archives, registry }),
        );
        assert.strictEqual(unsupported._tag, "Failure");
        if (unsupported._tag === "Failure")
          assert.strictEqual(unsupported.failure._tag, "Library.RestoreInvalid");
        assert.isFalse(yield* f.fs.exists(home));
        const missing = yield* library.content.stage(f.manifest, { localArchives: [], registry });
        assert.deepStrictEqual(
          new Set(missing.missing),
          new Set(f.manifest.collection_versions.map((copy) => copy.collection_version_id)),
        );
        assert.isFalse(yield* f.fs.exists(home));
        const failed = yield* Effect.result(
          library.content.stage(f.manifest, {
            localArchives: [],
            registry,
            download: () => Effect.fail("transport-refused" as const),
          }),
        );
        assert.strictEqual(failed._tag, "Failure");
        if (failed._tag === "Failure") assert.strictEqual(failed.failure, "transport-refused");
        assert.isFalse(yield* f.fs.exists(home));
      }).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("staging refuses reusable bytes changed during a download without overwriting them", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const home = join(f.root, "racing");
    const first = f.manifest.collection_versions[0];
    const sourceImport = f.manifest.imports.find(
      (item) => item.collection_version_id === first.collection_version_id,
    );
    if (sourceImport === undefined) return yield* Effect.die("Expected the retained acquisition");
    const collectionId = sourceImport.collection_id;
    const partial = {
      ...f.manifest,
      collections: f.manifest.collections.filter((item) => item.collection_id === collectionId),
      skills: f.manifest.skills.filter((item) => item.collection_id === collectionId),
      imports: f.manifest.imports.filter(
        (item) => item.collection_version_id === first.collection_version_id,
      ),
      collection_versions: [first],
      snapshot_digests: [first.hash],
      enabled: [],
    };
    const unexpected = join(
      collectionVersionPath(join(home, "originals"), first.hash),
      "unexpected.txt",
    );
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      yield* library.content.stage(partial, { localArchives: f.archives, registry });
      const result = yield* Effect.result(
        library.content.stage(f.manifest, {
          localArchives: [],
          registry,
          download: (hash) =>
            Effect.gen(function* () {
              yield* f.fs.writeFileString(unexpected, "changed during fetch\n");
              const archive = f.archives.find((candidate) => candidate.digest === hash);
              if (archive === undefined) return yield* Effect.die("Unexpected download");
              return archive;
            }),
        }),
      );
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.strictEqual(result.failure._tag, "ContentAddressCollision");
      assert.strictEqual(yield* f.fs.readFileString(unexpected), "changed during fetch\n");
      assert.isFalse(yield* f.fs.exists(join(home, "state.json")));
    }).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
