import { captureDisk, assertDiskUnchanged } from "./disk-snapshot.js";
import * as Construction from "effect/Layer";
import * as Context from "effect/Context";
import { installEnabledSkills } from "./installed-skills.js";
import { assert } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema, Struct, Option } from "effect";
import { join } from "node:path";
import { systemError } from "effect/PlatformError";
import { LibraryState } from "@smolai/skit-core/library";
import { emptyLibraryFixture, type LibraryFixtureState } from "./library-home.js";
import { type InstallDestination } from "@smolai/skit-core/library";
import { makeMachineId } from "@smolai/skit-core/universal/consumer";
import { deterministicTreeHash } from "@smolai/skit-core/author";
import * as Library from "@smolai/skit-core/library";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import { registryHttpLayer } from "../../src/registry/registry-http.js";
import { librarySyncApi } from "../../src/library/sync/api.js";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { faultQueue, librarySyncServer } from "./library-sync-server.js";
import { testRoots } from "./roots.js";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";

/** Devices sharing one compare-and-swap Library server, with injectable one-shot faults. */
export const devices = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({
    prefix: "skit-sync-crash-",
  });
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
          const response = yield* Effect.try({
            try: () => server.transport(incoming),
            catch: (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request: incoming, cause }),
              }),
          });
          const change =
            incoming.method === "GET" && new URL(incoming.url).pathname === "/api/library/portable"
              ? faults.take("ChangeStateWhenHeadRead")
              : undefined;
          // The head GET is a semantic boundary between local inspection and publication.
          if (change) yield* change.change.pipe(Effect.orDie);
          return HttpClientResponse.fromWeb(incoming, response);
        }),
      ),
    ),
  );
  const device = (name: string) =>
    Effect.gen(function* () {
      const home = join(workspace, name);
      let saves = 0;
      let savingLocal = false;
      let revision = "";
      let observedRevision = "";
      const observeRevision = (current: string) => {
        if (current === observedRevision) return;
        observedRevision = current;
        saves++;
        events.push(`save ${name}`);
      };
      // Observe real domain changes through the passive owner. Faults refuse the filesystem
      // permission boundary before the corresponding SQLite write starts.
      const files = FileSystem.FileSystem.of({
        ...fs,
        chmod: (path, mode) =>
          Effect.gen(function* () {
            if (path === join(home, "library.sqlite")) {
              const snapshot = yield* reader.read.pipe(Effect.orDie);
              const history = yield* reader.history.pipe(Effect.orDie);
              const pendingSync = history.operations.some(
                (operation) =>
                  operation._tag === "Pending" && operation.steps[0]?.step._tag === "Sync",
              );
              if (savingLocal && pendingSync) {
                const obstruction = faults.take(
                  "ObstructAfterSave",
                  (fault) => fault.home === home,
                );
                if (obstruction)
                  yield* fs.writeFileString(obstruction.path, "occupied by a file\n");
              }
              if (snapshot.revision !== revision) {
                revision = snapshot.revision;
                observeRevision(snapshot.revision);
                const obstruction = faults.take(
                  "ObstructAfterSave",
                  (fault) =>
                    fault.home === home &&
                    snapshot._tag === "Present" &&
                    snapshot.state.sync_ancestry?.revision_id === server.remote?.revision_id,
                );
                if (obstruction)
                  yield* fs.writeFileString(obstruction.path, "occupied by a file\n");
              }
              if (savingLocal) {
                const ready = history.operations.some(
                  (operation) =>
                    operation._tag === "Pending" &&
                    operation.steps[0]?.step._tag === "Sync" &&
                    operation.steps[0].status === "Done" &&
                    operation.steps[1]?.step._tag === "Sync" &&
                    operation.steps[1].status === "Pending",
                );
                if (faults.take("FailSave", (fault) => !fault.anchoredOnly || ready))
                  return yield* systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "chmod",
                    pathOrDescriptor: path,
                    description: "Test refuses local Library write",
                  });
              }
            }
            yield* fs.chmod(path, mode);
          }),
      });
      const root = join(workspace, `${name}-skills`);
      const rootFor = (target: InstallDestination) => (target === "agents" ? root : undefined);
      /** Loader maintenance happens here, outside the save-counting filesystem. */
      const maintained = Effect.flatMap(Library.Service, (library) => library.read).pipe(
        Effect.provide(Library.layer({ home, roots: testRoots(home) })),
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      // Capture a passive owner before any interruption; later reads must not start recovery.
      const reader = yield* Library.Service.pipe(
        Effect.provide(Library.layer({ home, roots: testRoots(home) })),
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      revision = (yield* reader.read).revision;
      observedRevision = revision;
      const state = Effect.map(reader.read, (snapshot) =>
        snapshot._tag === "Present" ? snapshot.state : emptyLibraryFixture(),
      );
      /** How this device routes installs: the roots its Library is built from. */
      const syncInventory = (
        route: (target: InstallDestination) => string | undefined = rootFor,
        inventory?: InventoryRootOptions,
      ): InventoryRootOptions => {
        const agents = route("agents");
        const claude = route("claude");
        return (
          inventory ?? {
            home: workspace,
            configHome: join(workspace, "config"),
            overrides: {
              ...(agents ? { codex: [agents] } : {}),
              ...(claude ? { "claude-code": [claude] } : {}),
            },
          }
        );
      };
      /** This home's Library owner, routed as this device's sync installs. */
      const owner = (
        route: (target: InstallDestination) => string | undefined = rootFor,
        inventory?: InventoryRootOptions,
      ) =>
        Effect.gen(function* () {
          yield* maintained;
          return Context.get(
            yield* Construction.build(
              Library.layer({ home, roots: syncInventory(route, inventory) }),
            ),
            Library.Service,
          );
        });
      const owned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          // External fixture restores belong to the next operation's baseline, not its writes.
          const before = yield* reader.read;
          revision = before.revision;
          observedRevision = before.revision;
          return yield* effect.pipe(
            Effect.provide(skitConfigurationLayer(home)),
            Effect.provideService(FileSystem.FileSystem, files),
            // Include the final committed revision even when no later writer opens this database.
            Effect.ensuring(
              reader.read.pipe(
                Effect.tap((snapshot) => Effect.sync(() => observeRevision(snapshot.revision))),
                Effect.orDie,
              ),
            ),
          );
        });
      const unchanged = Effect.map(
        captureDisk([home, root, join(workspace, ".skit-backups")], { identity: true }),
        (disk) => ({ check: assertDiskUnchanged(disk) }),
      );
      const machineId = makeMachineId();
      return {
        home,
        root,
        /** Every root a sync may write: the home, its installed skills, and their backups. */
        disk: [home, root, join(workspace, ".skit-backups")],
        /** Domain revisions observed at writer opens and completion of each device operation. */
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
        owner,
        unchanged,
        importInstalledSkillEdit: (
          installedSkill: LibraryFixtureState["installed_skills"][number],
        ) =>
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
        /** An independent local change accepted through the public owner's reviewed operations. */
        edit: (change: (state: LibraryState) => LibraryState) =>
          owned(
            Effect.gen(function* () {
              const library = yield* owner(rootFor, testRoots(home));
              let base = yield* library.read;
              if (base._tag === "Absent") {
                yield* library.setup([], { base });
                base = yield* library.read;
              }
              const current = base._tag === "Present" ? base.state : emptyLibraryFixture();
              const next = change(current);
              // Ancestry is accepted from a Registry head; restoring it requires restoring the Library.
              assert.deepStrictEqual(next.sync_ancestry, current.sync_ancestry);
              assert.deepStrictEqual(next.assessmentAcceptances, current.assessmentAcceptances);
              assert.deepStrictEqual(next.installed_skills, current.installed_skills);
              const portableChanged = [
                "collections",
                "skills",
                "collection_versions",
                "imports",
              ].some(
                (key) =>
                  JSON.stringify(Reflect.get(current, key)) !==
                  JSON.stringify(Reflect.get(next, key)),
              );
              if (
                portableChanged ||
                next.device_skill_selection !== current.device_skill_selection
              ) {
                const manifest = yield* library.manifest;
                const snapshotDigests = next.collection_versions
                  .filter(
                    (version) =>
                      !next.imports.some(
                        (source) =>
                          source.collection_version_id === version.collection_version_id &&
                          source.kind === "source" &&
                          source.revision !== undefined &&
                          (source.source_identity.kind === "github" ||
                            source.source_identity.kind === "git" ||
                            source.source_identity.kind === "registry"),
                      ),
                  )
                  .map((version) => version.hash);
                const target = yield* Library.LibraryManifest.makeEffect({
                  ...manifest,
                  collections: next.collections,
                  skills: next.skills,
                  collection_versions: next.collection_versions,
                  imports: next.imports,
                  enabled: next.enabled,
                  snapshot_digests: [...new Set(snapshotDigests)].sort(),
                });
                const staged = yield* library.content.stage(target, {
                  localArchives: base._tag === "Present" ? yield* library.content.pack(base) : [],
                  registry: { origin: "https://registry.test", token: Option.none() },
                });
                const plan = yield* library.plan(
                  {
                    _tag: "Sync",
                    staged,
                    acceptedBase: Option.fromUndefinedOr(current.sync_ancestry),
                    deviceSelection: Option.fromUndefinedOr(next.device_skill_selection),
                    pendingOrigin: Option.fromUndefinedOr(next.pending_device_selection_origin),
                    remote: Option.none(),
                  },
                  { base },
                );
                if (Library.isRemoteSyncPlan(plan))
                  return yield* Effect.die("Expected a local Library review");
                yield* library.apply({ _tag: "Apply", plan });
              }
              const portable = yield* library.read;
              const active = portable._tag === "Present" ? portable.state : current;
              // Invocation and repository choices are local enable intents, never part of a portable manifest.
              for (const scope of [
                {
                  scope: { kind: "global" },
                  enabled:
                    next.device_skill_selection?.mode === "choose"
                      ? next.device_skill_selection.enabled
                      : next.enabled,
                  policies:
                    next.device_skill_selection?.mode === "choose"
                      ? next.device_skill_selection.invocation_policies
                      : next.invocation_policies,
                },
                ...next.repositories.map((repository) => ({
                  scope: { kind: "repository", root: repository.root },
                  enabled: repository.enabled,
                  policies: repository.invocation_policies,
                })),
              ]) {
                const previous =
                  scope.scope.kind === "global"
                    ? active.device_skill_selection?.mode === "choose"
                      ? active.device_skill_selection.enabled
                      : active.enabled
                    : (active.repositories.find(
                        (repository) => repository.root === Reflect.get(scope.scope, "root"),
                      )?.enabled ?? []);
                for (const binding of previous) {
                  if (
                    scope.enabled.some((next) => JSON.stringify(next) === JSON.stringify(binding))
                  )
                    continue;
                  const where = yield* Schema.decodeUnknownEffect(Library.InstallScope)(
                    scope.scope,
                  );
                  const plan = yield* library.plan(
                    {
                      _tag: "Enabled",
                      changes: [
                        {
                          _tag: "Disable",
                          subject:
                            "skill" in binding
                              ? { _tag: "Skill", id: binding.skill }
                              : { _tag: "Collection", id: binding.collection },
                          ...("collection" in binding ? { members: "whole" } : {}),
                          where: [where],
                        },
                      ],
                    },
                    { base: yield* library.read },
                  );
                  yield* library.apply({ _tag: "Apply", plan });
                }
                for (const enabled of scope.enabled) {
                  const invocation =
                    "skill" in enabled ? scope.policies?.[enabled.skill] : undefined;
                  const policies =
                    scope.scope.kind === "global"
                      ? active.device_skill_selection?.mode === "choose"
                        ? active.device_skill_selection.invocation_policies
                        : active.invocation_policies
                      : active.repositories.find(
                          (repository) => repository.root === Reflect.get(scope.scope, "root"),
                        )?.invocation_policies;
                  if (
                    previous.some((item) => JSON.stringify(item) === JSON.stringify(enabled)) &&
                    (invocation === undefined ||
                      ("skill" in enabled && policies?.[enabled.skill] === invocation))
                  )
                    continue;
                  const checkedScope = yield* Schema.decodeUnknownEffect(Library.InstallScope)(
                    scope.scope,
                  );
                  const request = yield* library.plan(
                    {
                      _tag: "Enabled",
                      changes: [
                        {
                          _tag: "Enable",
                          subject:
                            "skill" in enabled
                              ? { _tag: "Skill", id: enabled.skill }
                              : { _tag: "Collection", id: enabled.collection },
                          where: [checkedScope],
                          ...("collection" in enabled ? { members: "whole" as const } : {}),
                          ...(invocation === undefined ? {} : { invocation }),
                        },
                      ],
                    },
                    { base: yield* library.read },
                  );
                  yield* library.apply({ _tag: "Apply", plan: request });
                }
              }
              for (const scope of [
                {
                  where: { kind: "global" },
                  policies:
                    next.device_skill_selection?.mode === "choose"
                      ? next.device_skill_selection.invocation_policies
                      : next.invocation_policies,
                },
                ...next.repositories.map((repository) => ({
                  where: { kind: "repository", root: repository.root },
                  policies: repository.invocation_policies,
                })),
              ]) {
                for (const skill of next.skills) {
                  const invocation = scope.policies?.[skill.skill_id];
                  if (invocation === undefined) continue;
                  const existing =
                    scope.where.kind === "global"
                      ? active.device_skill_selection?.mode === "choose"
                        ? active.device_skill_selection.invocation_policies
                        : active.invocation_policies
                      : active.repositories.find(
                          (repository) => repository.root === Reflect.get(scope.where, "root"),
                        )?.invocation_policies;
                  if (existing?.[skill.skill_id] === invocation) continue;
                  const where = yield* Schema.decodeUnknownEffect(Library.InstallScope)(
                    scope.where,
                  );
                  const plan = yield* library.plan(
                    {
                      _tag: "Enabled",
                      changes: [
                        {
                          _tag: "Enable",
                          subject: { _tag: "Skill", id: skill.skill_id },
                          where: [where],
                          invocation,
                        },
                      ],
                    },
                    { base: yield* library.read },
                  );
                  yield* library.apply({ _tag: "Apply", plan });
                }
              }
            }),
          ),
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
              return yield* library.apply({
                _tag: "Apply",
                plan: yield* library.plan(
                  { _tag: "Remove", collectionId: id },
                  { base: yield* library.read },
                ),
              });
            }),
          ),
        project: (
          scope: { kind: "global" } | { kind: "repository"; root: string } = {
            kind: "global",
          },
          skillsDirectory = root,
          target: InstallDestination = "agents",
        ) =>
          owned(
            installEnabledSkills({
              target,
              scope,
              root: skillsDirectory,
              variantsPath: join(home, "variants"),
            }),
          ),
        sync: (
          options: {
            origin?: string;
            progress?: Parameters<Library.Interface["sync"]>[0]["progress"];
            restoreProgress?: Parameters<Library.Interface["sync"]>[0]["restoreProgress"];
            onPlan?: Parameters<Library.Interface["sync"]>[0]["onPlan"];
            apply?: boolean;
            takeRemote?: readonly string[];
            keepEnabled?: readonly string[];
            deviceSelection?: Parameters<Library.Interface["sync"]>[0]["deviceSelection"];
            /** The roots this device's Library is built from; defaults to `rootFor`'s. */
            inventory?: InventoryRootOptions;
            rootFor?: (target: InstallDestination) => string | undefined;
          } = {},
        ) =>
          Effect.flatMap(
            Effect.zip(
              maintained,
              librarySyncApi({ origin: options.origin ?? "https://registry.test", token: "test" }),
            ),
            ([, transport]) =>
              Effect.flatMap(Library.Service, (library) =>
                library.sync(
                  {
                    origin: "https://registry.test",
                    token: "test",
                    apply: true,
                    ...Struct.omit(options, ["inventory", "rootFor"]),
                    progress: {
                      around: (phase, operation) =>
                        phase.kind === "save-local"
                          ? Effect.acquireUseRelease(
                              Effect.sync(() => {
                                savingLocal = true;
                              }),
                              () => options.progress?.around(phase, operation) ?? operation,
                              () =>
                                Effect.sync(() => {
                                  savingLocal = false;
                                }),
                            )
                          : (options.progress?.around(phase, operation) ?? operation),
                      tick: (tick) => options.progress?.tick(tick) ?? Effect.void,
                    },
                  },
                  transport,
                ),
              ).pipe(
                Effect.provide(
                  Library.layer({ home, roots: syncInventory(options.rootFor, options.inventory) }),
                ),
              ),
          ).pipe(Effect.provide(http), Effect.scoped, owned),
      };
    });
  return {
    fs,
    a: yield* device("a"),
    b: yield* device("b"),
    c: yield* device("c"),
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
