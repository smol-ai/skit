import { assert, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Schema } from "effect";
import { join } from "node:path";
import {
  LibraryStore,
  LibraryWriteRequest,
  SnapshotArchive,
  deterministicTreeHashEffect,
  libraryStoreLayer,
  makeMachineId,
  removeCollectionEffect,
  retainObservedCollectionEffect,
  skitLayer,
  withLibraryWriter,
  type LibraryManifest,
} from "@smolai/skit-core";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { syncLibraryEffect } from "../src/workflows/library/library-sync.js";
import { testHttpClientLayer, type TestHttpHandler } from "./helpers/http-test-client.js";

/**
 * Devices sharing one compare-and-swap Library server. `loseNextWriteResponse` commits the next
 * Library write and then answers as if it had failed, as a timeout after the commit would.
 */
const devices = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-crash-" });
  let published: { library_id: string; revision_id: string; manifest: LibraryManifest } | null =
    null;
  const snapshots = new Map<string, typeof SnapshotArchive.Type>();
  const faults = { loseNextWriteResponse: false };
  let writes = 0;
  const transport: TestHttpHandler = (incoming) => {
    const path = new URL(incoming.url).pathname;
    if (path.startsWith("/api/libraries/")) {
      const archive = snapshots.get(decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)));
      assert.ok(archive);
      return Response.json(archive);
    }
    if (path === "/api/library/portable" && incoming.method === "GET")
      return published === null
        ? Response.json({ error: "library_not_found" }, { status: 404 })
        : Response.json({ library: published });
    if (incoming.body._tag !== "Uint8Array") assert.fail("Expected an encoded JSON body");
    const payload: unknown = JSON.parse(new TextDecoder().decode(incoming.body.body));
    if (path === "/api/library/snapshots") {
      const archive = Schema.decodeUnknownSync(SnapshotArchive)(payload);
      snapshots.set(archive.digest, archive);
      return Response.json({
        library_id: "library_test",
        snapshot_digest: archive.digest,
        reused: false,
      });
    }
    if (path === "/api/library/portable" && incoming.method === "PUT") {
      const request = Schema.decodeUnknownSync(LibraryWriteRequest)(payload);
      if (request.expected_revision_id !== (published?.revision_id ?? null))
        return Response.json({ error: "revision_conflict" }, { status: 409 });
      published = {
        library_id: "library_test",
        revision_id: `revision_${++writes}`,
        manifest: request.manifest,
      };
      if (faults.loseNextWriteResponse) {
        faults.loseNextWriteResponse = false;
        return Response.json({ error: "storage_failure" }, { status: 503 });
      }
      return Response.json({ library: published });
    }
    assert.fail(`Unexpected request: ${incoming.method} ${path}`);
  };
  const http = registryHttpLayer(testHttpClientLayer(transport));
  const device = (name: string) => {
    const home = join(workspace, name);
    const layer = libraryStoreLayer({ home });
    const root = join(workspace, `${name}-skills`);
    const machineId = makeMachineId();
    return {
      home,
      state: Effect.flatMap(LibraryStore, (store) => store.load).pipe(Effect.provide(layer)),
      retain: (repository: string) =>
        Effect.gen(function* () {
          const sourcePath = join(workspace, repository);
          yield* fs.makeDirectory(sourcePath, { recursive: true });
          yield* fs.writeFileString(join(sourcePath, "SKILL.md"), `${repository}\n`);
          return yield* retainObservedCollectionEffect({
            machineId,
            source: { type: "github", owner: "fixture", repository },
            input: sourcePath,
            retainedAt: "2026-01-01T00:00:00.000Z",
            skills: [
              {
                name: repository,
                sourcePath,
                relativePath: ".",
                observedHash: yield* deterministicTreeHashEffect(sourcePath),
              },
            ],
            observations: [],
          });
        }).pipe(withLibraryWriter, Effect.provide(layer)),
      remove: (collectionId: string) =>
        removeCollectionEffect({ collectionId, variantsPath: join(home, "variants") }).pipe(
          withLibraryWriter,
          Effect.provide(layer),
        ),
      sync: (options: { adopt?: boolean } = {}) =>
        syncLibraryEffect({
          origin: "https://registry.test",
          token: "test",
          apply: true,
          ...options,
          projection: {
            variantsPath: join(home, "variants"),
            rootFor: (target) => (target === "agents" ? root : undefined),
          },
        }).pipe(withLibraryWriter, Effect.provide(layer), Effect.provide(http), Effect.scoped),
    };
  };
  return {
    fs,
    a: device("a"),
    b: device("b"),
    faults,
    remote: Effect.sync(() => published),
    remoteCollections: Effect.sync(
      () => published?.manifest.collections.map((item) => item.collection_id).sort() ?? [],
    ),
  };
});

it.effect("each sync publishes state with the revision it reconciled against", () =>
  Effect.gen(function* () {
    const { a, b, remote } = yield* devices;
    const anchoredAt = (state: typeof a.state) =>
      Effect.gen(function* () {
        const head = yield* remote;
        const ancestry = (yield* state).sync_ancestry;
        assert.strictEqual(ancestry?.revision_id, head?.revision_id);
        assert.strictEqual(ancestry?.library_id, head?.library_id);
      });
    yield* a.retain("first");
    assert.strictEqual((yield* a.sync()).status, "pushed");
    yield* anchoredAt(a.state);
    assert.strictEqual((yield* b.sync()).status, "pulled");
    yield* anchoredAt(b.state);
    yield* b.retain("second");
    assert.strictEqual((yield* b.sync()).status, "merged");
    yield* anchoredAt(b.state);
    assert.strictEqual((yield* a.sync()).status, "merged");
    yield* anchoredAt(a.state);
    assert.strictEqual((yield* b.sync()).status, "clean");
    yield* anchoredAt(b.state);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

/**
 * Restoring an older `state.json`, from a backup or after a write lost to power failure, restores
 * the ancestry it was reconciled with. The next sync must not read the Collections the remote
 * gained since as local deletions and remove them from every device.
 */
it.effect("an older state.json does not delete Collections the remote gained since", () =>
  Effect.gen(function* () {
    const { fs, a, b, remoteCollections } = yield* devices;
    yield* a.retain("first");
    yield* a.sync();
    yield* b.sync();
    yield* b.retain("second");
    yield* b.sync();
    const added = yield* remoteCollections;
    assert.strictEqual(added.length, 2);

    const stateBeforeMerge = yield* fs.readFileString(join(a.home, "state.json"));
    assert.strictEqual((yield* a.sync()).status, "merged");
    yield* fs.writeFileString(join(a.home, "state.json"), stateBeforeMerge);

    yield* a.sync();
    assert.deepStrictEqual(yield* remoteCollections, added);
    assert.strictEqual((yield* a.state).collections.length, 2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a local removal after sync still removes the Collection everywhere", () =>
  Effect.gen(function* () {
    const { a, b, remoteCollections } = yield* devices;
    yield* a.retain("first");
    const removed = (yield* a.state).collections[0];
    assert.ok(removed);
    yield* a.retain("second");
    yield* a.sync();
    yield* b.sync();

    yield* a.remove(removed.collection_id);
    assert.ok((yield* a.state).sync_ancestry, "ordinary mutations keep sync ancestry");
    assert.strictEqual((yield* a.sync()).status, "merged");
    assert.notInclude(yield* remoteCollections, removed.collection_id);
    assert.strictEqual((yield* b.sync()).status, "merged");
    assert.isFalse(
      (yield* b.state).collections.some((item) => item.collection_id === removed.collection_id),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a write committed without a response leaves coherent state and converges", () =>
  Effect.gen(function* () {
    const { fs, a, b, faults, remoteCollections } = yield* devices;
    yield* a.retain("first");
    yield* a.sync();
    yield* b.sync();
    yield* a.retain("second");
    const stateBefore = yield* fs.readFileString(join(a.home, "state.json"));

    faults.loseNextWriteResponse = true;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(a.sync())));
    assert.strictEqual(yield* fs.readFileString(join(a.home, "state.json")), stateBefore);
    const committed = yield* remoteCollections;
    assert.strictEqual(committed.length, 2);

    // The remote already holds A's state, so the retry only re-anchors it.
    assert.strictEqual((yield* a.sync()).status, "clean");
    assert.deepStrictEqual(yield* remoteCollections, committed);
    assert.strictEqual((yield* b.sync()).status, "merged");
    assert.strictEqual((yield* b.state).collections.length, 2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("state without ancestry adopts explicitly and keeps remote-only Collections", () =>
  Effect.gen(function* () {
    const { a, b, remoteCollections } = yield* devices;
    yield* a.retain("first");
    yield* a.sync();
    // B has never synced, as a home upgraded from the sidecar-based ancestry has not either.
    yield* b.retain("second");
    const remoteOnly = yield* remoteCollections;

    assert.strictEqual((yield* b.sync()).status, "adoption_required");
    assert.strictEqual((yield* b.sync({ adopt: true })).status, "merged");
    const adopted = yield* remoteCollections;
    assert.strictEqual(adopted.length, 2);
    for (const collectionId of remoteOnly) assert.include(adopted, collectionId);
    assert.strictEqual((yield* a.sync()).status, "merged");
    assert.strictEqual((yield* a.state).collections.length, 2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
