import { assert } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { join } from "node:path";
import {
  retainChangedProjectionEffect,
  type ManagedProjection,
  InvalidLibraryState,
  LibraryStore,
  LibraryWriteRequest,
  SnapshotArchive,
  deterministicTreeHashEffect,
  libraryStoreLayer,
  makeMachineId,
  projectBindingEffect,
  removeCollectionEffect,
  retainObservedCollectionEffect,
  withLibraryWriter,
  type LibraryManifest,
  type LibraryState,
  type ProjectionTarget,
} from "@smolai/skit-core";
import { registryHttpLayer } from "../../src/registry/registry-http.js";
import { syncLibraryEffect } from "../../src/workflows/library/library-sync.js";
import { testHttpClientLayer, type TestHttpHandler } from "./http-test-client.js";

/**
 * Devices sharing one compare-and-swap Library server. `loseNextWriteResponse` commits the next
 * Library write and then answers as if it had failed, as a timeout after the commit would.
 */
export const devices = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-crash-" });
  let published: { library_id: string; revision_id: string; manifest: LibraryManifest } | null =
    null;
  const snapshots = new Map<string, typeof SnapshotArchive.Type>();
  const faults = {
    loseNextWriteResponse: false,
    failNextAnchoredPublish: false,
    rejectNextWrite: false,
  };
  let libraryId = "library_test";
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
        library_id: libraryId,
        snapshot_digest: archive.digest,
        reused: false,
      });
    }
    if (path === "/api/library/portable" && incoming.method === "PUT") {
      const request = Schema.decodeUnknownSync(LibraryWriteRequest)(payload);
      if (faults.rejectNextWrite) {
        faults.rejectNextWrite = false;
        return Response.json({ error: "revision_conflict" }, { status: 409 });
      }
      if (request.expected_revision_id !== (published?.revision_id ?? null))
        return Response.json({ error: "revision_conflict" }, { status: 409 });
      for (const digest of request.manifest.snapshot_digests)
        assert.isTrue(snapshots.has(digest), `Snapshot ${digest} must exist before committing`);
      published = {
        library_id: libraryId,
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
    const layer = Layer.effect(
      LibraryStore,
      Effect.map(LibraryStore, (store) => ({
        ...store,
        publish: Effect.fn("Test.LibraryStore.publish")(function* (state: LibraryState) {
          if (
            faults.failNextAnchoredPublish &&
            state.sync_ancestry?.revision_id === published?.revision_id
          ) {
            faults.failNextAnchoredPublish = false;
            return yield* new InvalidLibraryState({
              path: home,
              detail: "Test interruption before merged state publication",
            });
          }
          yield* store.publish(state);
        }),
      })),
    ).pipe(Layer.provide(libraryStoreLayer({ home })));
    const root = join(workspace, `${name}-skills`);
    const machineId = makeMachineId();
    return {
      home,
      root,
      state: Effect.flatMap(LibraryStore, (store) => store.load).pipe(Effect.provide(layer)),
      retainProjectionEdit: (projection: ManagedProjection) =>
        Effect.gen(function* () {
          return yield* retainChangedProjectionEffect({
            skillId: projection.skill_id,
            projectionId: projection.projection_id,
            path: projection.path,
            observedHash: yield* deterministicTreeHashEffect(projection.path),
            retainedAt: "2026-02-01T00:00:00Z",
          });
        }).pipe(withLibraryWriter, Effect.provide(layer)),
      /** A local edit made outside sync, as any Library command makes one. */
      edit: (change: (state: LibraryState) => LibraryState) =>
        withLibraryWriter(
          Effect.flatMap(LibraryStore, (store) =>
            Effect.flatMap(store.load, (state) => store.publish(change(state))),
          ),
        ).pipe(Effect.provide(layer)),
      retain: (
        repository: string,
        options: { name?: string; bytes?: string; retainedAt?: string } = {},
      ) =>
        Effect.gen(function* () {
          const sourcePath = join(workspace, repository);
          yield* fs.makeDirectory(sourcePath, { recursive: true });
          yield* fs.writeFileString(
            join(sourcePath, "SKILL.md"),
            options.bytes ?? `${repository}\n`,
          );
          return yield* retainObservedCollectionEffect({
            machineId,
            source: { type: "github", owner: "fixture", repository },
            input: sourcePath,
            retainedAt: options.retainedAt ?? "2026-01-01T00:00:00.000Z",
            skills: [
              {
                name: options.name ?? repository,
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
      project: (
        scope: { kind: "global" } | { kind: "repository"; root: string } = { kind: "global" },
        projectionRoot = root,
      ) =>
        projectBindingEffect({
          target: "agents",
          scope,
          root: projectionRoot,
          variantsPath: join(home, "variants"),
        }).pipe(withLibraryWriter, Effect.provide(layer)),
      sync: (
        options: {
          apply?: boolean;
          adopt?: boolean;
          takeRemote?: readonly string[];
          keepEnabled?: readonly string[];
          rootFor?: (target: ProjectionTarget) => string | undefined;
        } = {},
      ) =>
        syncLibraryEffect({
          origin: "https://registry.test",
          token: "test",
          apply: true,
          ...options,
          projection: {
            variantsPath: join(home, "variants"),
            rootFor: options.rootFor ?? ((target) => (target === "agents" ? root : undefined)),
          },
        }).pipe(withLibraryWriter, Effect.provide(layer), Effect.provide(http), Effect.scoped),
    };
  };
  return {
    fs,
    a: device("a"),
    b: device("b"),
    c: device("c"),
    faults,
    remote: Effect.sync(() => published),
    /** The Registry loses the Library, as a deleted account or reset database would. */
    resetRemote: Effect.sync(() => {
      published = null;
      snapshots.clear();
      libraryId = "library_recreated";
    }),
    remoteCollections: Effect.sync(
      () => published?.manifest.collections.map((item) => item.collection_id).sort() ?? [],
    ),
  };
});
