import { captureDisk, assertDiskUnchanged } from "./disk-snapshot.js";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import { makeMachineId } from "@smolai/skit-core/universal/consumer";
import {
  createSkitArchive,
  deterministicTreeHash,
  initSkit,
  readSkitDescriptor,
  validateSkitDirectory,
} from "@smolai/skit-core/author";
import { type HarnessName, type SkillsDirectoryOverrides } from "@smolai/skit-core/harnesses";
import { Effect, FileSystem, Layer, Option } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FetchHttpClient, type HttpClient } from "effect/http";

import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";
import { testHttpClientLayer, type TestHttpHandler } from "./http-test-client.js";
import { registryHttpLayer } from "../../src/registry/registry-http.js";

import * as Library from "@smolai/skit-core/library";
import { testRoots } from "./roots.js";

export type LibraryFixtureState = Extract<Library.Snapshot, { readonly _tag: "Present" }>["state"];
/** Independent empty domain fixture; absence is asserted through Snapshot. */
export const emptyLibraryFixture = (): LibraryFixtureState => ({
  collections: [],
  skills: [],
  collection_versions: [],
  imports: [],
  enabled: [],
  repositories: [],
  installed_skills: [],
  unmanaged: [],
  schemaVersion: 12,
});

type ImportRequest = Parameters<Library.Interface["import"]["collection"]>[0];

export type HarnessRoots = SkillsDirectoryOverrides;

export interface LibraryHomeInput {
  readonly home: string;
  readonly harnesses?: readonly HarnessName[];
  readonly harnessRoot?: string;
  readonly roots?: HarnessRoots;
  readonly inventoryHome?: string;
  readonly registryBaseUrl?: string;
  readonly registryToken?: string;
  readonly now?: () => string;
  readonly transport?: TestHttpHandler;
  readonly state?: unknown;
}

const directoryFor = (harness: HarnessName) => (harness === "claude-code" ? "claude" : harness);
export const testMachineId = makeMachineId();
export const initializeLibraryMachine = Effect.fn("Test.initializeLibraryMachine")(function* (
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(home, { recursive: true });
  yield* fs.writeFileString(
    join(home, "machine.json"),
    JSON.stringify({
      schemaVersion: 3,
      machineId: testMachineId,
      displayName: "Test machine",
      repositoryRoots: [],
    }),
  );
});

export const libraryHome = Effect.fn("Test.libraryHome")(function* (input: LibraryHomeInput) {
  const fs = yield* FileSystem.FileSystem;
  const home = input.home;
  const harnessRoot = input.harnessRoot ?? join(home, "harnesses");
  const harnesses = input.harnesses ?? [];
  const roots: HarnessRoots = {
    ...Object.fromEntries(
      harnesses.map((harness) => [harness, [join(harnessRoot, directoryFor(harness))]]),
    ),
    ...input.roots,
  };
  yield* fs.makeDirectory(home, { recursive: true });
  for (const harness of harnesses)
    yield* fs.makeDirectory(join(harnessRoot, directoryFor(harness)), { recursive: true });
  if (input.state !== undefined)
    yield* fs.writeFileString(
      join(home, "state.json"),
      `${JSON.stringify(input.state, null, 2)}\n`,
    );
  const now = input.now ?? (() => new Date().toISOString());
  const statePath = join(home, "state.json");
  const inventory = {
    home: input.inventoryHome ?? home,
    configHome: join(input.inventoryHome ?? home, "config"),
    overrides: roots,
  };
  const installOptions: InventoryRootOptions = inventory;
  const transport: Layer.Layer<HttpClient.HttpClient> = input.transport
    ? testHttpClientLayer(input.transport)
    : FetchHttpClient.layer;
  if (input.registryBaseUrl !== undefined) {
    yield* fs.writeFileString(
      join(home, "auth.json"),
      JSON.stringify({
        schemaVersion: 1,
        activeOrigin: input.registryBaseUrl,
        servers:
          input.registryToken === undefined
            ? {}
            : {
                [input.registryBaseUrl]: {
                  token: input.registryToken,
                  tokenId: "test-credential",
                  tokenPrefix: "test",
                  scopes: ["library:sync"],
                },
              },
      }),
    );
  }
  const owned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          skitConfigurationLayer(home),
          Library.layer({ home, roots: inventory }).pipe(Layer.provide(transport)),
          transport,
          registryHttpLayer(transport),
        ),
      ),
    );
  const snapshot = owned(Effect.flatMap(Library.Service, (library) => library.read));
  const durable = Effect.flatMap(snapshot, (current): Effect.Effect<LibraryFixtureState> =>
    current._tag === "Present"
      ? Effect.succeed(current.state)
      : Effect.die("Expected persisted Library state; use snapshot to assert absence"),
  );
  return {
    home,
    harnessRoot,
    roots,
    now,
    statePath,
    originals: join(home, "originals"),
    inventory,
    installOptions,
    variantsPath: join(home, "variants"),
    owned,
    snapshot,
    durable,
    /** Restore portable records using the same reviewed content plan as a Registry restore. */
    restore: (
      change: (manifest: Library.LibraryManifest) => Library.LibraryManifest,
      deviceSelection?: LibraryFixtureState["device_skill_selection"],
    ) =>
      writingTo(
        home,
        Effect.gen(function* () {
          const library = yield* Library.Service;
          const base = yield* library.read;
          const manifest = change(yield* library.manifest);
          const staged = yield* library.content.stage(manifest, {
            localArchives: base._tag === "Present" ? yield* library.content.pack(base) : [],
            registry: { origin: "https://registry.test", token: Option.none() },
          });
          const plan = yield* library.plan(
            {
              _tag: "Sync",
              staged,
              acceptedBase: Option.fromUndefinedOr(
                base._tag === "Present" ? base.state.sync_ancestry : undefined,
              ),
              deviceSelection: Option.fromUndefinedOr(
                deviceSelection ??
                  (base._tag === "Present" ? base.state.device_skill_selection : undefined),
              ),
              pendingOrigin: Option.fromUndefinedOr(
                base._tag === "Present" ? base.state.pending_device_selection_origin : undefined,
              ),
              remote: Option.none(),
            },
            { base },
          );
          if (Library.isRemoteSyncPlan(plan))
            return yield* Effect.die("Expected a local content plan");
          yield* library.apply({ _tag: "Apply", plan });
        }),
      ),
    /** Preserve exact disk bytes and identities, excluding only SQLite's coordination sidecars. */
    unchanged: (extra: readonly string[] = []) =>
      Effect.map(captureDisk([home, harnessRoot, ...extra], { identity: true }), (disk) => ({
        check: assertDiskUnchanged(disk),
      })),
    /** Establish bindings through reviewed owner intents, without routing installations. */
    enable: (
      bindings: LibraryFixtureState["enabled"],
      where: readonly Library.InstallScope[] = [{ kind: "global" }],
    ) =>
      writingTo(
        home,
        Effect.gen(function* () {
          const library = yield* Library.Service;
          for (const binding of bindings) {
            const plan = yield* library.plan(
              {
                _tag: "Enabled",
                changes: [
                  {
                    _tag: "Enable",
                    subject:
                      "skill" in binding
                        ? { _tag: "Skill", id: binding.skill }
                        : { _tag: "Collection", id: binding.collection },
                    ...("collection" in binding ? { members: "whole" } : {}),
                    where,
                  },
                ],
              },
              { base: yield* library.read },
            );
            yield* library.apply({ _tag: "Apply", plan });
          }
        }),
      ),
    installedSkill: (harness: HarnessName, ...segments: string[]) =>
      harness === "devin"
        ? join(inventory.configHome, "devin", "skills", ...segments)
        : join(harnessRoot, directoryFor(harness), ...segments),
  };
});

export type LibraryHome = Effect.Success<ReturnType<typeof libraryHome>>;

export const scratch = (prefix: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix }));

export type SkitFixtureName =
  | "authored"
  | "duplicate-skills"
  | "generated-wrapper"
  | "hazardous"
  | "library"
  | "readme-authored"
  | "unmanaged-adoption";

export const copySkitFixtureEffect = (name: SkitFixtureName, root: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.copy(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), root),
  );

export const bindInitializedSkit = Effect.fn("Test.bindInitializedSkit")(function* (
  root: string,
  namespace: string,
  origin = "https://registry.example",
) {
  const fs = yield* FileSystem.FileSystem;
  const descriptor = yield* readSkitDescriptor(root);
  yield* fs.writeFileString(
    join(root, "skit.remote.json"),
    `${JSON.stringify({ schema: "skit.remote.v1", origin, namespace, skit: descriptor.slug })}\n`,
  );
});

export const boundSkit = Effect.fn("Test.boundSkit")(function* (path: string, namespace: string) {
  yield* initSkit(path);
  yield* bindInitializedSkit(path, namespace);
  return path;
});

export const releaseIdentity = (source: string, release: string) =>
  validateSkitDirectory(source, release, { assessmentContext: "import" }).pipe(
    Effect.map((validated) => validated.identity),
  );

export const archiveBytes = Effect.fn("Test.archiveBytes")(function* (
  source: string,
  archivePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* createSkitArchive(source, archivePath);
  return yield* fs.readFile(archivePath);
});

export { deterministicTreeHash };

/** Retain observed bytes into the Library at `home`, through the owner production consumes. */
export const importCollectionIn = (home: string) => (request: ImportRequest) =>
  Effect.flatMap(Library.Service, (library) => library.import.collection(request)).pipe(
    Effect.provide(Library.layer({ home, roots: testRoots(home) })),
  );

/** Change the Library at `home` the way a front end does: through its owner. */
export const writingTo = <A, E, R>(home: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Library.layer({ home, roots: testRoots(home) }).pipe(
        Layer.provideMerge(skitConfigurationLayer(home)),
      ),
    ),
  );
