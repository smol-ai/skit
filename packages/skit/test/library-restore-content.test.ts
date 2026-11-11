import { SourceNotFound } from "../src/sources/failures.js";
import { openLibrary, inspectLibrary } from "./helpers/library-store.js";

import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { dirname, join } from "node:path";
import { readSnapshotArchive } from "../src/library/snapshot-archive.js";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { libraryManifestFromLocalState } from "../src/library/library-state.js";
import { makeMachineId } from "../src/library/entity-ids.js";
import { planCollectionVersions } from "../src/library/collection-version-plan.js";
import { type RestorePhase, type RestoreTick } from "../src/library/restore-progress.js";
import { collectionVersionPath } from "../src/library/collection-version.js";
import { SourceProcess } from "../src/platform/source-process.js";
import { type SnapshotArchive } from "../src/library/library-contracts.js";
import { skitLayer } from "../src/platform/layer.js";

const origin = "https://registry.example";
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-restore-content-" });
  const home = join(root, "seed");
  const originalsPath = join(root, "restored", "originals");
  const sourceRoot = join(root, "release");
  const skillPath = join(sourceRoot, "skills", "review");
  const privatePath = join(root, "private");
  const bytes = "---\nname: review\ndescription: Review code.\n---\nReview.\n";
  yield* fs.makeDirectory(skillPath, { recursive: true });
  yield* fs.makeDirectory(privatePath);
  yield* fs.writeFileString(join(skillPath, "SKILL.md"), bytes);
  yield* fs.writeFileString(join(sourceRoot, "unrelated.txt"), "Excluded from retained subset\n");
  yield* fs.writeFileString(join(privatePath, "SKILL.md"), "Private notes\n");
  const machineId = makeMachineId();
  const source = yield* Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* openLibrary(home);
      return yield* owner.import.collection({
        machineId,
        source: { type: "registry", namespace: "tim", slug: "tools", version: "1.2.3" },
        // Reconstruction must use the identity and recorded release, never this input.
        input: "https://wrong.example/not-the-source",
        revision: { kind: "release", version: "1.2.3" },
        importedAt: "2026-10-16T00:00:00.000Z",
        skills: [
          {
            name: "review",
            sourcePath: skillPath,
            relativePath: "skills/review",
            currentHash: yield* deterministicTreeHash(skillPath),
          },
        ],
        lockFileEntries: [],
      });
    }),
  );
  const privateCopy = yield* Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* openLibrary(home);
      return yield* owner.import.collection({
        machineId,
        source: { type: "local", path: privatePath },
        input: privatePath,
        importedAt: "2026-10-16T00:00:00.000Z",
        skills: [
          {
            name: "private",
            sourcePath: privatePath,
            relativePath: ".",
            currentHash: yield* deterministicTreeHash(privatePath),
          },
        ],
        lockFileEntries: [],
      });
    }),
  );
  const saved = yield* inspectLibrary(home);
  assert(saved.present);
  const manifest = yield* libraryManifestFromLocalState(saved.state);
  assert.deepStrictEqual(manifest.snapshot_digests, [privateCopy.snapshotDigest]);
  const privateArchive = yield* readSnapshotArchive(
    collectionVersionPath(join(home, "originals"), privateCopy.snapshotDigest),
  );
  const archivePath = join(root, "release.zip");
  const repack = Effect.gen(function* () {
    if (yield* fs.exists(archivePath)) yield* fs.remove(archivePath);
    const result = yield* (yield* SourceProcess).run("zip", ["-qr", archivePath, "."], {
      cwd: sourceRoot,
    });
    assert.strictEqual(result.exitCode, 0);
    return yield* fs.readFile(archivePath);
  });
  let release = yield* repack;
  let status = 200;
  const phases: RestorePhase[] = [];
  const ticks: RestoreTick[] = [];
  const requests: { url: string; authorization: string | undefined }[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      return HttpClientResponse.fromWeb(
        request,
        new Response(new Uint8Array(release), {
          status,
          headers: { "content-type": "application/zip" },
        }),
      );
    }),
  );
  const restore = (available: readonly SnapshotArchive[] = [privateArchive]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const plan = yield* planCollectionVersions(manifest, {
          originalsPath,
          localArchives: available,
        });
        return yield* Effect.gen(function* () {
          const owner = yield* openLibrary(dirname(originalsPath));
          return yield* owner.content.stage(manifest, {
            plan: plan,
            registry: { origin: origin, token: Option.some("restore-token") },
            progress: {
              around: (phase, operation) =>
                Effect.sync(() => {
                  phases.push(phase);
                }).pipe(Effect.andThen(operation)),
              tick: (tick) =>
                Effect.sync(() => {
                  ticks.push(tick);
                }),
            },
          });
        });
      }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    );
  return {
    fs,
    root,
    home,
    sourceRoot,
    skillPath,
    bytes,
    source,
    privateCopy,
    privateArchive,
    manifest,
    originalsPath,
    requests,
    client,
    phases,
    ticks,
    restore,
    unavailable: () => {
      status = 404;
    },
    changeSource: Effect.gen(function* () {
      yield* fs.writeFileString(join(skillPath, "SKILL.md"), `${bytes}\nChanged\n`);
      release = yield* repack;
    }),
  };
});

it.effect("prepares downloaded private content and exact source content without publishing", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const restored = yield* f.restore();
    assert.deepStrictEqual(f.phases, [
      { kind: "fetch-source", subject: "https://wrong.example/not-the-source" },
      { kind: "retain", total: 2 },
    ]);
    assert.deepStrictEqual(
      f.ticks.map(({ phase, completed }) => [phase.kind, completed]),
      [
        ["retain", 0],
        ["retain", 1],
        ["retain", 1],
        ["retain", 2],
      ],
    );
    assert.deepStrictEqual(restored.state.imports, f.manifest.imports);
    assert.deepStrictEqual(restored.state.collection_versions, f.manifest.collection_versions);
    assert.deepStrictEqual(f.requests, [
      {
        url: `${origin}/api/skits/tim/tools/releases/1.2.3/download`,
        authorization: "Bearer restore-token",
      },
    ]);
    const sourceRoot = collectionVersionPath(f.originalsPath, f.source.snapshotDigest);
    assert.strictEqual((yield* readSnapshotArchive(sourceRoot)).digest, f.source.snapshotDigest);
    assert.strictEqual(
      yield* f.fs.readFileString(join(sourceRoot, "skills/review/SKILL.md")),
      f.bytes,
    );
    assert.strictEqual(yield* f.fs.exists(join(sourceRoot, "unrelated.txt")), false);
    assert.strictEqual(
      yield* f.fs.readFileString(
        join(collectionVersionPath(f.originalsPath, f.privateCopy.snapshotDigest), "SKILL.md"),
      ),
      "Private notes\n",
    );
    assert.strictEqual(yield* f.fs.exists(join(f.root, "restored", "state.json")), false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("available source archives require no source access", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sourceArchive = yield* readSnapshotArchive(
      collectionVersionPath(join(f.home, "originals"), f.source.snapshotDigest),
    );
    f.unavailable();
    const restored = yield* f.restore([f.privateArchive, sourceArchive]);
    assert.deepStrictEqual(restored.state.collection_versions, f.manifest.collection_versions);
    assert.deepStrictEqual(f.requests, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a missing private snapshot is reported before transport or retention", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const staged = yield* f.restore([]);
    assert.deepStrictEqual(staged.missing, [f.privateCopy.collectionVersionId]);
    assert.deepStrictEqual(staged.retained, []);
    assert.deepStrictEqual(f.requests, []);
    assert.deepStrictEqual(f.phases, []);
    assert.strictEqual(yield* f.fs.exists(f.originalsPath), false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("changed historical source bytes fail before retaining available private content", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.changeSource;
    const error = yield* f.restore().pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.SyncSourceRestoreInvalid");
    if (error._tag === "Library.SyncSourceRestoreInvalid") {
      assert.strictEqual(error.hash, f.source.snapshotDigest);
      assert.strictEqual(error.reason._tag, "HashMismatch");
    }
    assert.strictEqual(yield* f.fs.exists(f.originalsPath), false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an unavailable pinned source fails before retaining available private content", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.unavailable();
    const error = yield* f.restore().pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.SyncSourceRestoreInvalid");
    if (error._tag === "Library.SyncSourceRestoreInvalid") {
      assert.strictEqual(error.reason._tag, "SourceFetchFailed");
      if (error.reason._tag === "SourceFetchFailed")
        assert.instanceOf(error.reason.failure, SourceNotFound);
    }
    assert.strictEqual(yield* f.fs.exists(f.originalsPath), false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an unpinned acquisition requires snapshot bytes instead of source reconstruction", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const manifest = {
      ...f.manifest,
      imports: f.manifest.imports.map((sourceImport) => {
        const { revision: _revision, ...unpinned } = sourceImport;
        return unpinned;
      }),
      snapshot_digests: f.manifest.collection_versions.map((copy) => copy.hash),
    };
    const owner = yield* openLibrary(dirname(f.originalsPath));
    const staged = yield* owner.content.stage(manifest, {
      localArchives: [f.privateArchive],
      registry: { origin, token: Option.none() },
    });
    assert.deepStrictEqual(staged.missing, [f.source.collectionVersionId]);
    assert.deepStrictEqual(staged.retained, []);
    assert.deepStrictEqual(f.requests, []);
    assert.strictEqual(yield* f.fs.exists(f.originalsPath), false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("restoring existing copies avoids temporary trees and still rejects damaged bytes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.restore();
    const archives = yield* Effect.forEach(f.manifest.collection_versions, (tree) =>
      readSnapshotArchive(collectionVersionPath(f.originalsPath, tree.hash)),
    );
    f.unavailable();
    const ticks: RestoreTick[] = [];
    const plan = yield* planCollectionVersions(f.manifest, {
      originalsPath: f.originalsPath,
      localArchives: archives,
    });
    const restore = Effect.gen(function* () {
      const owner = yield* openLibrary(dirname(f.originalsPath));
      return yield* owner.content.stage(f.manifest, {
        plan: plan,
        registry: { origin: "https://registry.example", token: Option.none() },
        progress: {
          around: (_phase, operation) => operation,
          tick: (tick) =>
            Effect.sync(() => {
              ticks.push(tick);
            }),
        },
      });
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...f.fs,
        makeTempDirectoryScoped: () => Effect.die("existing copies must not be unpacked"),
      }),
    );
    const restored = yield* restore;
    assert.deepStrictEqual(restored.state.collection_versions, f.manifest.collection_versions);
    assert.deepStrictEqual(
      ticks.map((tick) => tick.completed),
      [0, 1, 1, 2],
    );
    yield* f.fs.writeFileString(
      join(collectionVersionPath(f.originalsPath, f.privateCopy.snapshotDigest), "SKILL.md"),
      "Damaged",
    );
    const error = yield* restore.pipe(Effect.flip);
    assert.strictEqual(error._tag, "ContentAddressCollision");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("existing unlisted objects restore without source access or private archives", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.restore();
    f.requests.length = 0;
    f.unavailable();
    f.phases.length = 0;
    f.ticks.length = 0;
    const restored = yield* f.restore([]);
    assert.deepStrictEqual(f.phases, [
      { kind: "verify-local", total: 2 },
      { kind: "retain", total: 2 },
    ]);
    assert.deepStrictEqual(
      f.ticks.map(({ phase, completed }) => [phase.kind, completed]),
      [
        ["verify-local", 0],
        ["verify-local", 1],
        ["verify-local", 1],
        ["verify-local", 2],
        ["retain", 0],
        ["retain", 1],
        ["retain", 1],
        ["retain", 2],
      ],
    );
    assert.deepStrictEqual(restored.state.collection_versions, f.manifest.collection_versions);
    assert.deepStrictEqual(f.requests, []);
    yield* f.fs.writeFileString(
      join(collectionVersionPath(f.originalsPath, f.privateCopy.snapshotDigest), "SKILL.md"),
      "Damaged",
    );
    const error = yield* f.restore([]).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ContentAddressCollision");
    assert.deepStrictEqual(f.requests, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "planning observes disk availability without reading bytes or writing, then preparation rejects corruption before transport",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.restore();
      f.requests.length = 0;
      yield* f.fs.writeFileString(
        join(collectionVersionPath(f.originalsPath, f.privateCopy.snapshotDigest), "SKILL.md"),
        "Damaged",
      );
      const plan = yield* planCollectionVersions(f.manifest, {
        originalsPath: f.originalsPath,
        localArchives: [],
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          readFile: () => Effect.die("planning must not read content"),
          readFileString: () => Effect.die("planning must not read content"),
          writeFile: () => Effect.die("planning must not write"),
          makeDirectory: () => Effect.die("planning must not write"),
        }),
      );
      assert.deepStrictEqual(
        plan.reusable,
        f.manifest.collection_versions.map((copy) => copy.hash),
      );
      assert.deepStrictEqual(plan.download, []);
      assert.deepStrictEqual(plan.reacquire, []);
      const error = yield* Effect.gen(function* () {
        const owner = yield* openLibrary(dirname(f.originalsPath));
        return yield* owner.content.stage(f.manifest, {
          plan: plan,
          registry: { origin: "https://registry.example", token: Option.none() },
          download: () => Effect.die("corrupt reusable content must fail before transport"),
        });
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ContentAddressCollision");
      assert.deepStrictEqual(f.requests, []);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a copy disappearing after planning fails without an unplanned download", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.restore();
    const plan = yield* planCollectionVersions(f.manifest, {
      originalsPath: f.originalsPath,
      localArchives: [],
    });
    yield* f.fs.remove(collectionVersionPath(f.originalsPath, f.privateCopy.snapshotDigest), {
      recursive: true,
    });
    const error = yield* Effect.gen(function* () {
      const owner = yield* openLibrary(dirname(f.originalsPath));
      return yield* owner.content.stage(f.manifest, {
        plan: plan,
        registry: { origin: "https://registry.example", token: Option.none() },
        download: () => Effect.die("no unplanned download"),
      });
    }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.RestoreInvalid");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("public staging refuses inconsistent member hashes before content reuse", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.restore();
    f.requests.length = 0;
    const manifest = {
      ...f.manifest,
      collection_versions: f.manifest.collection_versions.map((copy) => ({
        ...copy,
        members: copy.members.map((member) => ({
          ...member,
          source_hash: f.source.snapshotDigest,
        })),
      })),
    };
    const plan = yield* planCollectionVersions(manifest, {
      originalsPath: f.originalsPath,
      localArchives: [],
    });
    const error = yield* Effect.gen(function* () {
      const owner = yield* openLibrary(dirname(f.originalsPath));
      return yield* owner.content.stage(manifest, {
        plan: plan,
        registry: { origin: "https://registry.example", token: Option.none() },
      });
    }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.RestoreInvalid");
    if (error._tag === "Library.RestoreInvalid")
      assert.strictEqual(error.reason._tag, "StateInvalid");
    assert.deepStrictEqual(f.requests, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an incomplete plan fails before retaining any available archive", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sourceArchive = yield* readSnapshotArchive(
      collectionVersionPath(join(f.home, "originals"), f.source.snapshotDigest),
    );
    const plan = yield* planCollectionVersions(f.manifest, {
      originalsPath: f.originalsPath,
      localArchives: [sourceArchive],
    });
    const error = yield* Effect.gen(function* () {
      const owner = yield* openLibrary(dirname(f.originalsPath));
      return yield* owner.content.stage(f.manifest, {
        plan: { ...plan, download: [] },
        registry: { origin: "https://registry.example", token: Option.none() },
      });
    }).pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.RestoreInvalid");
    assert.strictEqual(yield* f.fs.exists(f.originalsPath), false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "incomplete, foreign, and private-source plans fail before transport, progress, or writes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const plan = yield* planCollectionVersions(f.manifest, {
        originalsPath: f.originalsPath,
        localArchives: [],
      });
      const foreign = yield* readSnapshotArchive(f.sourceRoot);
      assert.isFalse(f.manifest.collection_versions.some((copy) => copy.hash === foreign.digest));
      const privateCopy = f.manifest.collection_versions.find(
        (copy) => copy.hash === f.privateCopy.snapshotDigest,
      );
      assert(privateCopy);
      let downloads = 0;
      for (const hasDownload of [false, true]) {
        for (const invalid of [
          { ...plan, download: [] },
          { ...plan, localArchives: [foreign] },
          { ...plan, reusable: [foreign.digest] },
          { ...plan, download: [...plan.download, foreign.digest] },
          { ...plan, download: [...plan.download, f.source.snapshotDigest] },
          { ...plan, reacquire: [...plan.reacquire, privateCopy.collection_version_id] },
        ]) {
          const error = yield* Effect.gen(function* () {
            const owner = yield* openLibrary(dirname(f.originalsPath));
            return yield* owner.content.stage(f.manifest, {
              plan: invalid,
              registry: { origin: "https://registry.example", token: Option.none() },
              ...(hasDownload
                ? {
                    download: () =>
                      Effect.sync(() => {
                        downloads++;
                        return f.privateArchive;
                      }),
                  }
                : {}),
              progress: {
                around: () => Effect.die("invalid plans must fail before opening a phase"),
                tick: () => Effect.die("invalid plans must not emit ticks"),
              },
            });
          }).pipe(Effect.provideService(HttpClient.HttpClient, f.client), Effect.flip);
          assert.strictEqual(error._tag, "Library.RestoreInvalid");
          assert.strictEqual(downloads, 0);
          assert.deepStrictEqual(f.requests, []);
          assert.strictEqual(yield* f.fs.exists(f.originalsPath), false);
        }
      }
      // A complete plan without its transport reports the unavailable copy without starting work.
      const staged = yield* Effect.gen(function* () {
        const owner = yield* openLibrary(dirname(f.originalsPath));
        return yield* owner.content.stage(f.manifest, {
          plan: plan,
          registry: { origin: "https://registry.example", token: Option.none() },
          progress: {
            around: () => Effect.die("missing transport must fail before phases"),
            tick: () => Effect.void,
          },
        });
      }).pipe(Effect.provideService(HttpClient.HttpClient, f.client));
      assert.deepStrictEqual(staged.missing, [f.privateCopy.collectionVersionId]);
      assert.deepStrictEqual(staged.retained, []);
      assert.deepStrictEqual(f.requests, []);
      assert.strictEqual(yield* f.fs.exists(f.originalsPath), false);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
