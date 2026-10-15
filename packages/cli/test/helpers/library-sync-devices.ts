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
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { faultQueue, librarySyncServer } from "./library-sync-server.js";

/** Devices sharing one compare-and-swap Library server, with injectable one-shot faults. */
export const devices = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-crash-" });
  const faults = faultQueue();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => assert.deepStrictEqual(faults.unconsumed(), [])),
  );
  // Registry write requests and local publications, in the order they happened.
  const events: string[] = [];
  const server = librarySyncServer(faults, events);
  const http = registryHttpLayer(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((incoming) =>
        Effect.gen(function* () {
          const response = yield* Effect.try(() => server.transport(incoming));
          const change =
            incoming.method === "GET" && new URL(incoming.url).pathname === "/api/library/portable"
              ? faults.take("ChangeStateWhenHeadRead")
              : undefined;
          // The head GET is a semantic boundary between local inspection and publication.
          if (change) {
            yield* fs.makeDirectory(change.home, { recursive: true });
            yield* fs.writeFileString(
              join(change.home, "state.json"),
              Schema.encodeSync(Schema.fromJsonString(LibraryState))(change.state),
            );
          }
          return HttpClientResponse.fromWeb(incoming, response);
        }).pipe(
          Effect.mapError(
            (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request: incoming, cause }),
              }),
          ),
        ),
      ),
    ),
  );
  const device = (name: string) => {
    const home = join(workspace, name);
    let publishes = 0;
    const layer = Layer.effect(
      LibraryStore,
      Effect.map(LibraryStore, (store) => ({
        ...store,
        publish: Effect.fn("Test.LibraryStore.publish")(function* (
          state: LibraryState,
          base: LibraryState,
        ) {
          publishes++;
          if (
            faults.take(
              "FailPublish",
              (fault) =>
                !fault.anchoredOnly ||
                state.sync_ancestry?.revision_id === server.remote?.revision_id,
            )
          )
            return yield* new InvalidLibraryState({
              path: home,
              detail: "Test interruption before merged state publication",
            });
          yield* store.publish(state, base);
          events.push(`publish ${name}`);
          const obstruction = faults.take("ObstructAfterPublish", (fault) => fault.home === home);
          if (obstruction) yield* fs.writeFileString(obstruction.path, "occupied by a file\n");
        }),
      })),
    ).pipe(Layer.provide(libraryStoreLayer({ home })));
    const root = join(workspace, `${name}-skills`);
    const machineId = makeMachineId();
    return {
      home,
      root,
      /** Every root a sync may write: the home, its projections, and their backups. */
      disk: [home, root, join(workspace, ".skit-backups")],
      /** Local state publications attempted through this home's LibraryStore, refused or not. */
      get publishes() {
        return publishes;
      },
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
            Effect.flatMap(store.load, (state) => store.publish(change(state), state)),
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
        Effect.flatMap(LibraryStore, (store) => store.load).pipe(
          Effect.flatMap((state) =>
            removeCollectionEffect(state, { collectionId, variantsPath: join(home, "variants") }),
          ),
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
          onProgress?: (message: string) => Effect.Effect<void>;
          onPlan?: Parameters<typeof syncLibraryEffect>[0]["onPlan"];
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
    inject: faults.inject,
    server,
    events,
    remote: Effect.sync(() => server.remote),
    /** The Registry loses the Library, as a deleted account or reset database would. */
    resetRemote: Effect.sync(() => server.reset()),
    remoteCollections: Effect.sync(
      () => server.remote?.manifest.collections.map((item) => item.collection_id).sort() ?? [],
    ),
  };
});
