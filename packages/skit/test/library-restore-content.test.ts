import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { join } from "node:path";
import {
  captureSnapshotArchiveEffect,
  deterministicTreeHashEffect,
  libraryManifestFromLocalStateEffect,
  makeMachineId,
  prepareRestoreEffect,
  retainedTreePath,
  retainObservedCollectionEffect,
  SourceProcess,
  withLibraryWriterLock,
  type SnapshotArchive,
} from "../src/index.js";
import { skitLayer } from "../src/platform/layer.js";
import { inLibrary, inspectLibrary } from "./helpers/library-store.js";

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
    withLibraryWriterLock(
      home,
      retainObservedCollectionEffect({
        machineId,
        source: { type: "registry", namespace: "tim", slug: "tools", version: "1.2.3" },
        // Reconstruction must use the identity and recorded release, never this input.
        input: "https://wrong.example/not-the-source",
        revision: { kind: "release", version: "1.2.3" },
        retainedAt: "2026-10-16T00:00:00.000Z",
        skills: [
          {
            name: "review",
            sourcePath: skillPath,
            relativePath: "skills/review",
            observedHash: yield* deterministicTreeHashEffect(skillPath),
          },
        ],
        observations: [],
      }).pipe(inLibrary(home)),
    ),
  );
  const privateCopy = yield* Effect.scoped(
    withLibraryWriterLock(
      home,
      retainObservedCollectionEffect({
        machineId,
        source: { type: "local", path: privatePath },
        input: privatePath,
        retainedAt: "2026-10-16T00:00:00.000Z",
        skills: [
          {
            name: "private",
            sourcePath: privatePath,
            relativePath: ".",
            observedHash: yield* deterministicTreeHashEffect(privatePath),
          },
        ],
        observations: [],
      }).pipe(inLibrary(home)),
    ),
  );
  const saved = yield* inspectLibrary(home);
  assert(saved.present);
  const manifest = yield* libraryManifestFromLocalStateEffect(saved.state);
  assert.deepStrictEqual(manifest.snapshot_digests, [privateCopy.snapshotDigest]);
  const privateArchive = yield* captureSnapshotArchiveEffect(
    retainedTreePath(join(home, "originals"), privateCopy.snapshotDigest),
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
      prepareRestoreEffect(manifest, available, {
        originalsPath,
        registryBaseUrl: origin,
        registryToken: "restore-token",
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
    assert.deepStrictEqual(restored.state.acquisitions, f.manifest.acquisitions);
    assert.deepStrictEqual(restored.state.retained_copies, f.manifest.retained_copies);
    assert.deepStrictEqual(f.requests, [
      {
        url: `${origin}/api/skits/tim/tools/releases/1.2.3/download`,
        authorization: "Bearer restore-token",
      },
    ]);
    const sourceRoot = retainedTreePath(f.originalsPath, f.source.snapshotDigest);
    assert.strictEqual(
      (yield* captureSnapshotArchiveEffect(sourceRoot)).digest,
      f.source.snapshotDigest,
    );
    assert.strictEqual(
      yield* f.fs.readFileString(join(sourceRoot, "skills/review/SKILL.md")),
      f.bytes,
    );
    assert.strictEqual(yield* f.fs.exists(join(sourceRoot, "unrelated.txt")), false);
    assert.strictEqual(
      yield* f.fs.readFileString(
        join(retainedTreePath(f.originalsPath, f.privateCopy.snapshotDigest), "SKILL.md"),
      ),
      "Private notes\n",
    );
    assert.strictEqual(yield* f.fs.exists(join(f.root, "restored", "state.json")), false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("available source archives require no source access", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sourceArchive = yield* captureSnapshotArchiveEffect(
      retainedTreePath(join(f.home, "originals"), f.source.snapshotDigest),
    );
    f.unavailable();
    const restored = yield* f.restore([f.privateArchive, sourceArchive]);
    assert.deepStrictEqual(restored.state.retained_copies, f.manifest.retained_copies);
    assert.deepStrictEqual(f.requests, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a missing private snapshot fails before retaining any content", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const error = yield* f.restore([]).pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.RestoreInvalid");
    if (error._tag === "Library.RestoreInvalid")
      assert.include(
        error.detail,
        `snapshot-backed retained copy ${f.privateCopy.snapshotDigest} not downloaded`,
      );
    // Source reconstruction cannot stand in for the missing private archive.
    assert(f.requests.every((request) => request.url.endsWith("/releases/1.2.3/download")));
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
      assert.strictEqual(error.digest, f.source.snapshotDigest);
      assert.include(error.detail, "source returned");
    }
    assert.strictEqual(yield* f.fs.exists(f.originalsPath), false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an unavailable pinned source fails before retaining available private content", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.unavailable();
    const error = yield* f.restore().pipe(Effect.flip);
    assert.strictEqual(error._tag, "SourceNotFound");
    assert.strictEqual(yield* f.fs.exists(f.originalsPath), false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an unpinned acquisition cannot reconstruct a missing source copy", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const manifest = {
      ...f.manifest,
      acquisitions: f.manifest.acquisitions.map((acquisition) => {
        const { revision: _revision, ...unpinned } = acquisition;
        return unpinned;
      }),
    };
    const error = yield* Effect.scoped(
      prepareRestoreEffect(manifest, [f.privateArchive], {
        originalsPath: f.originalsPath,
        registryBaseUrl: origin,
      }),
    ).pipe(Effect.flip);
    assert.strictEqual(error._tag, "Library.SyncSourceRestoreInvalid");
    if (error._tag === "Library.SyncSourceRestoreInvalid")
      assert.strictEqual(error.detail, "manifest has no exact source-restoration acquisition");
    assert.strictEqual(yield* f.fs.exists(f.originalsPath), false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("restoring existing copies avoids temporary trees and still rejects damaged bytes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.restore();
    const archives = yield* Effect.forEach(f.manifest.retained_copies, (tree) =>
      captureSnapshotArchiveEffect(retainedTreePath(f.originalsPath, tree.digest)),
    );
    f.unavailable();
    const progress: string[] = [];
    const restore = prepareRestoreEffect(f.manifest, archives, {
      originalsPath: f.originalsPath,
      onProgress: (message) =>
        Effect.sync(() => {
          progress.push(message);
        }),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...f.fs,
        makeTempDirectoryScoped: () => Effect.die("existing copies must not be unpacked"),
      }),
    );
    const restored = yield* restore;
    assert.deepStrictEqual(restored.state.retained_copies, f.manifest.retained_copies);
    assert.strictEqual(progress.length, f.manifest.retained_copies.length);
    yield* f.fs.writeFileString(
      join(retainedTreePath(f.originalsPath, f.privateCopy.snapshotDigest), "SKILL.md"),
      "Damaged",
    );
    const error = yield* restore.pipe(Effect.flip);
    assert.strictEqual(error._tag, "ContentAddressCollision");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
