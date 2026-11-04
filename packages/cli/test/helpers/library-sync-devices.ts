import { installEnabledSkills } from "./installed-skills.js";
import { assert } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { join } from "node:path";
import { systemError } from "effect/PlatformError";
import {
  type InstalledSkill,
  deterministicTreeHash,
  emptyLibraryState,
  makeMachineId,
  Library,
  InstalledSkills,
  LibraryState,
  skitConfigurationLayer,
  type InstallDestination,
} from "@smolai/skit-core";
import { registryHttpLayer } from "../../src/registry/registry-http.js";
import { syncLibrary } from "../../src/workflows/library/library-sync.js";
import {
  existingRepositorySkillsDirectory,
  findDuplicates,
} from "@smolai/skit-core/library/routing";
const syncInstalledSkills = Effect.fn("Test.syncInstalledSkills")(function* (
  state: LibraryState,
  rootFor: (target: InstallDestination) => string | undefined,
  inventory?: Parameters<typeof syncLibrary>[0]["inventory"],
) {
  const active = (["agents", "claude"] as const).filter((target) => rootFor(target) !== undefined);
  const context = yield* Effect.context<
    | import("effect").FileSystem.FileSystem
    | import("@smolai/skit-core").LinkStat
    | import("effect/crypto").Digest.Digest
  >();
  return yield* InstalledSkills.make({
    active: Effect.succeed(active),
    destinations: (scope) =>
      Effect.succeed(
        active.flatMap((destination) => {
          const root =
            scope.kind === "global"
              ? rootFor(destination)
              : existingRepositorySkillsDirectory(state, scope.root, destination);
          return root === undefined ? [] : [{ destination, root }];
        }),
      ),
    duplicates: {
      scan: (scope, names) =>
        inventory === undefined
          ? Effect.succeed({ copies: [], warnings: [], roots: [] })
          : Effect.map(findDuplicates(inventory, scope, names), (copies) => ({
              copies,
              warnings: [],
              roots: [],
            })).pipe(Effect.provide(context)),
    },
  });
});
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

/** state.json as the store reads it: validated, with undeclared fields kept as written. */
const StateFile = Schema.fromJsonString(
  Schema.Unknown.pipe(Schema.refine(Schema.is(LibraryState))),
);
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
  let snapshotReads = 0;
  const server = librarySyncServer(faults, events);
  const http = registryHttpLayer(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((incoming) =>
        Effect.gen(function* () {
          if (incoming.method === "GET" && new URL(incoming.url).pathname.includes("/snapshots/"))
            snapshotReads++;
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
    const statePath = join(home, "state.json");
    let saves = 0;
    /**
     * This home's real filesystem, observing the one durable commit of local state: the atomic
     * rename onto state.json. Every Library operation below runs over it.
     */
    const files = FileSystem.FileSystem.of({
      ...fs,
      rename: Effect.fn("Test.Device.rename")(function* (from: string, to: string) {
        if (to !== statePath) return yield* fs.rename(from, to);
        saves++;
        const next = yield* Effect.flatMap(
          fs.readFileString(from),
          Schema.decodeUnknownEffect(StateFile),
        ).pipe(Effect.orDie);
        if (
          faults.take(
            "FailSave",
            (fault) =>
              !fault.anchoredOnly || next.sync_ancestry?.revision_id === server.remote?.revision_id,
          )
        )
          return yield* Effect.fail(
            systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "rename",
              pathOrDescriptor: to,
              description: "Test interruption before local state publication",
            }),
          );
        yield* fs.rename(from, to);
        events.push(`save ${name}`);
        const obstruction = faults.take(
          "ObstructAfterSave",
          (fault) =>
            fault.home === home && next.sync_ancestry?.revision_id === server.remote?.revision_id,
        );
        if (obstruction) yield* fs.writeFileString(obstruction.path, "occupied by a file\n");
      }),
    });
    /** Durable local state as written, read without constructing an owner that could recover. */
    const state = Effect.gen(function* () {
      if (!(yield* fs.exists(statePath))) return emptyLibraryState();
      return yield* Effect.flatMap(
        fs.readFileString(statePath),
        Schema.decodeUnknownEffect(StateFile),
      );
    });
    const root = join(workspace, `${name}-skills`);
    const rootFor = (target: InstallDestination) => (target === "agents" ? root : undefined);
    /** This home's Library owner, routed as this device's sync installs. */
    const owner = (
      route: (target: InstallDestination) => string | undefined = rootFor,
      inventory?: Parameters<typeof syncLibrary>[0]["inventory"],
    ) =>
      Effect.gen(function* () {
        // Opening a Library first migrates and recovers it: loader maintenance, not a save.
        const opened = yield* (yield* Library.make(home).pipe(
          Effect.provideServiceEffect(InstalledSkills.Service, InstalledSkills.make()),
          Effect.provideService(FileSystem.FileSystem, fs),
        )).read;
        const routed = yield* syncInstalledSkills(
          opened._tag === "Present" ? opened.state : emptyLibraryState(),
          route,
          inventory,
        );
        return yield* Library.make(home).pipe(
          Effect.provideService(InstalledSkills.Service, routed),
        );
      });
    const owned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(skitConfigurationLayer(home)),
        Effect.provideService(FileSystem.FileSystem, files),
      );
    const machineId = makeMachineId();
    return {
      home,
      root,
      /** Every root a sync may write: the home, its installed skills, and their backups. */
      disk: [home, root, join(workspace, ".skit-backups")],
      /** Local state publications attempted on this home's state.json, refused or not. */
      get saves() {
        return saves;
      },
      corruptOriginal: Effect.gen(function* () {
        const hash = (yield* state).collection_versions[0]!.hash.slice("sha256:".length);
        yield* fs.writeFileString(
          join(home, "originals", hash.slice(0, 2), hash, "SKILL.md"),
          "corrupted original\n",
        );
      }),
      state,
      importInstalledSkillEdit: (installedSkill: InstalledSkill) =>
        owned(
          Effect.gen(function* () {
            const library = yield* owner();
            return yield* library.import.edit({
              skillId: installedSkill.skill_id,
              installedSkillId: installedSkill.installed_skill_id,
              path: installedSkill.path,
              currentHash: yield* deterministicTreeHash(installedSkill.path),
              importedAt: "2026-02-01T00:00:00Z",
            });
          }),
        ),
      /** A local edit made outside sync: another writer replacing state.json. */
      edit: (change: (state: LibraryState) => LibraryState) =>
        Effect.gen(function* () {
          const next = change(yield* state);
          yield* fs.makeDirectory(home, { recursive: true });
          yield* fs.writeFileString(statePath, yield* Schema.encodeEffect(StateFile)(next));
        }),
      importSource: (
        repository: string,
        options: { name?: string; bytes?: string; importedAt?: string } = {},
      ) =>
        owned(
          Effect.gen(function* () {
            const sourcePath = join(workspace, repository);
            yield* fs.makeDirectory(sourcePath, { recursive: true });
            yield* fs.writeFileString(
              join(sourcePath, "SKILL.md"),
              options.bytes ?? `${repository}\n`,
            );
            const library = yield* owner();
            return yield* library.import.collection({
              machineId,
              source: { type: "github", owner: "fixture", repository },
              input: sourcePath,
              importedAt: options.importedAt ?? "2026-01-01T00:00:00.000Z",
              skills: [
                {
                  name: options.name ?? repository,
                  sourcePath,
                  relativePath: ".",
                  currentHash: yield* deterministicTreeHash(sourcePath),
                },
              ],
              lockFileEntries: [],
            });
          }),
        ),
      importMany: (repository: string, names: readonly string[], importedAt: string) =>
        owned(
          Effect.gen(function* () {
            const sourcePath = join(workspace, repository);
            const skills = yield* Effect.forEach(names, (skillName) =>
              Effect.gen(function* () {
                const path = join(sourcePath, skillName);
                yield* fs.makeDirectory(path, { recursive: true });
                yield* fs.writeFileString(join(path, "SKILL.md"), `${skillName}\n`);
                return {
                  name: skillName,
                  sourcePath: path,
                  relativePath: skillName,
                  currentHash: yield* deterministicTreeHash(path),
                };
              }),
            );
            const library = yield* owner();
            return yield* library.import.collection({
              machineId,
              source: { type: "github", owner: "fixture", repository },
              input: sourcePath,
              importedAt,
              skills,
              lockFileEntries: [],
            });
          }),
        ),
      remove: (collectionId: string) =>
        owned(
          Effect.gen(function* () {
            const id = (yield* state).collections.find(
              (item) => item.collection_id === collectionId,
            )?.collection_id;
            assert.ok(id);
            const library = yield* owner();
            return yield* library.apply(
              yield* library.plan(
                { _tag: "Remove", collectionId: id },
                { base: yield* library.read },
              ),
            );
          }),
        ),
      project: (
        scope: { kind: "global" } | { kind: "repository"; root: string } = { kind: "global" },
        skillsDirectory = root,
      ) =>
        owned(
          installEnabledSkills({
            target: "agents",
            scope,
            root: skillsDirectory,
            variantsPath: join(home, "variants"),
          }),
        ),
      sync: (
        options: {
          progress?: Parameters<typeof syncLibrary>[0]["progress"];
          restoreProgress?: Parameters<typeof syncLibrary>[0]["restoreProgress"];
          onPlan?: Parameters<typeof syncLibrary>[0]["onPlan"];
          apply?: boolean;
          adopt?: boolean;
          takeRemote?: readonly string[];
          keepEnabled?: readonly string[];
          deviceSelection?: Parameters<typeof syncLibrary>[0]["deviceSelection"];
          inventory?: Parameters<typeof syncLibrary>[0]["inventory"];
          rootFor?: (target: InstallDestination) => string | undefined;
        } = {},
      ) =>
        syncLibrary({
          origin: "https://registry.test",
          token: "test",
          apply: true,
          ...options,
          installedSkill: { rootFor: options.rootFor ?? rootFor },
        }).pipe(
          Effect.provide(Layer.effect(Library.Service, owner(options.rootFor, options.inventory))),
          Effect.provide(http),
          Effect.scoped,
          owned,
        ),
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
    get snapshotReads() {
      return snapshotReads;
    },
    remote: Effect.sync(() => server.remote),
    /** The Registry loses the Library, as a deleted account or reset database would. */
    resetRemote: Effect.sync(() => server.reset()),
    remoteCollections: Effect.sync(
      () => server.remote?.manifest.collections.map((item) => item.collection_id).sort() ?? [],
    ),
  };
});
