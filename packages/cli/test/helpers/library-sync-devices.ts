import { assert } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { join } from "node:path";
import {
  retainChangedProjectionEffect,
  type ManagedProjection,
  InvalidLibraryState,
  LibraryStore,
  deterministicTreeHashEffect,
  libraryStoreLayer,
  makeMachineId,
  projectBindingEffect,
  removeCollectionEffect,
  retainObservedCollectionEffect,
  withLibraryWriter,
  LibraryState,
  type ProjectionTarget,
} from "@smolai/skit-core";
import { registryHttpLayer } from "../../src/registry/registry-http.js";
import { syncLibraryEffect } from "../../src/workflows/library/library-sync.js";
import { testHttpClientLayer } from "./http-test-client.js";
import { librarySyncServer } from "./library-sync-server.js";

/**
 * Devices sharing one compare-and-swap Library server. `loseNextWriteResponse` commits the next
 * Library write and then answers as if it had failed, as a timeout after the commit would.
 */
export const devices = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-crash-" });
  const server = librarySyncServer();
  const faults = Object.assign(server.faults, {
    failNextAnchoredPublish: false,
    failNextLocalPublish: false,
    changeBeforeReinspect: undefined as { home: string; state: LibraryState } | undefined,
    blockProjectionAfterPublish: undefined as { home: string; path: string } | undefined,
  });
  const http = registryHttpLayer(testHttpClientLayer(server.transport));
  const device = (name: string) => {
    const home = join(workspace, name);
    let inspections = 0;
    const layer = Layer.effect(
      LibraryStore,
      Effect.map(LibraryStore, (store) => ({
        ...store,
        inspect: Effect.gen(function* () {
          inspections++;
          if (inspections === 2 && faults.changeBeforeReinspect?.home === home) {
            const change = faults.changeBeforeReinspect;
            faults.changeBeforeReinspect = undefined;
            // A non-cooperating writer changes the real file at the restore/re-inspect boundary.
            yield* fs.makeDirectory(home, { recursive: true });
            yield* fs.writeFileString(
              join(home, "state.json"),
              Schema.encodeSync(Schema.fromJsonString(LibraryState))(change.state),
            );
          }
          return yield* store.inspect;
        }),
        publish: Effect.fn("Test.LibraryStore.publish")(function* (state: LibraryState) {
          if (
            faults.failNextLocalPublish ||
            (faults.failNextAnchoredPublish &&
              state.sync_ancestry?.revision_id === server.remote?.revision_id)
          ) {
            faults.failNextAnchoredPublish = false;
            faults.failNextLocalPublish = false;
            return yield* new InvalidLibraryState({
              path: home,
              detail: "Test interruption before merged state publication",
            });
          }
          yield* store.publish(state);
          if (faults.blockProjectionAfterPublish?.home === home) {
            const obstruction = faults.blockProjectionAfterPublish;
            faults.blockProjectionAfterPublish = undefined;
            yield* fs.writeFileString(obstruction.path, "occupied by a file\n");
          }
        }),
      })),
    ).pipe(Layer.provide(libraryStoreLayer({ home })));
    const root = join(workspace, `${name}-skills`);
    const machineId = makeMachineId();
    return {
      home,
      root,
      corruptOriginal: Effect.gen(function* () {
        const state = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
          Effect.provide(layer),
        );
        const digest = state.retained_copies[0]!.digest.slice("sha256:".length);
        yield* fs.writeFileString(
          join(home, "originals", digest.slice(0, 2), digest, "SKILL.md"),
          "corrupted original\n",
        );
      }),
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
        Effect.suspend(() => {
          inspections = 0;
          return syncLibraryEffect({
            origin: "https://registry.test",
            token: "test",
            apply: true,
            ...options,
            projection: {
              variantsPath: join(home, "variants"),
              rootFor: options.rootFor ?? ((target) => (target === "agents" ? root : undefined)),
            },
          }).pipe(withLibraryWriter, Effect.provide(layer), Effect.provide(http), Effect.scoped);
        }),
    };
  };
  return {
    fs,
    a: device("a"),
    b: device("b"),
    c: device("c"),
    faults,
    server,
    remote: Effect.sync(() => server.remote),
    /** The Registry loses the Library, as a deleted account or reset database would. */
    resetRemote: Effect.sync(() => server.reset()),
    remoteCollections: Effect.sync(
      () => server.remote?.manifest.collections.map((item) => item.collection_id).sort() ?? [],
    ),
  };
});

/** Capture state and owned projection bytes, then assert that a stopped sync leaves them intact. */
export const untouched = Effect.fn("Test.untouched")(function* (device: {
  home: string;
  state: Effect.Effect<LibraryState, unknown, FileSystem.FileSystem>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const statePath = join(device.home, "state.json");
  const stateBytes = (yield* fs.exists(statePath))
    ? Array.from(yield* fs.readFile(statePath))
    : null;
  const paths =
    stateBytes === null ? [] : (yield* device.state).projections.map((item) => item.path);
  const readTree = Effect.fn("Test.projectionBytes")(function* (
    root: string,
  ): Effect.fn.Return<Record<string, readonly number[]>, unknown, FileSystem.FileSystem> {
    const result: Record<string, readonly number[]> = {};
    if (!(yield* fs.exists(root))) return result;
    for (const name of (yield* fs.readDirectory(root)).sort()) {
      const path = join(root, name);
      if ((yield* fs.stat(path)).type === "Directory") {
        for (const [child, bytes] of Object.entries(yield* readTree(path)))
          result[join(name, child)] = bytes;
      } else result[name] = Array.from(yield* fs.readFile(path));
    }
    return result;
  });
  const before = yield* Effect.forEach(paths, readTree);
  return Effect.gen(function* () {
    assert.deepStrictEqual(
      (yield* fs.exists(statePath)) ? Array.from(yield* fs.readFile(statePath)) : null,
      stateBytes,
    );
    assert.deepStrictEqual(yield* Effect.forEach(paths, readTree), before);
  });
});
