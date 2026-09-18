import { Effect, FileSystem, Layer, Result } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import {
  createSkitArchiveEffect,
  deterministicTreeHashEffect,
  initSkitEffect,
  libraryStoreLayer,
  libraryAuditLogLayer,
  treeHasherLayer,
  TreeHasher,
  LibraryStore,
  LibraryAuditLog,
  readSkitDescriptorEffect,
  validateSkitDirectoryEffect,
  type HarnessName,
  type LibraryState,
  makeMachineId,
  retainObservedCollectionEffect,
  withLibraryWriter,
} from "@smolai/skit-core";
import type { ProjectionOptions } from "../../src/workflows/library/projection-options.js";
import type { RetentionOptions } from "../../src/workflows/library/retention-options.js";
import { fetchTestClientLayer } from "./http-test-client.js";
import { registryAuthAccessLayer } from "../../src/registry/auth-service.js";
import { RegistryHttp, registryHttpLayer } from "../../src/registry/registry-http.js";

export type HarnessRoots = {
  readonly codex?: string;
  readonly claude?: string;
  readonly opencode?: string;
  readonly devin?: string[];
};

export interface LibraryHomeInput {
  readonly home: string;
  readonly harnesses?: readonly HarnessName[];
  readonly harnessRoot?: string;
  readonly roots?: HarnessRoots;
  readonly inventoryHome?: string;
  readonly registryBaseUrl?: string;
  readonly registryToken?: string;
  readonly now?: () => string;
  readonly transport?: typeof globalThis.fetch;
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
  const derived: HarnessRoots = {
    ...(harnesses.includes("codex") ? { codex: join(harnessRoot, "codex") } : {}),
    ...(harnesses.includes("claude-code") ? { claude: join(harnessRoot, "claude") } : {}),
    ...(harnesses.includes("opencode") ? { opencode: join(harnessRoot, "opencode") } : {}),
    ...(harnesses.includes("devin") ? { devin: [join(harnessRoot, "devin")] } : {}),
  };
  const roots: HarnessRoots = { ...derived, ...input.roots };
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
  const bindings: ProjectionOptions = {
    ...inventory,
    statePath,
    variantsPath: join(home, "variants"),
  };
  const addOptions: RetentionOptions = {
    installation: {
      statePath,
      variantsPath: bindings.variantsPath,
      rootFor: (harness) =>
        harness === "codex"
          ? roots.codex
          : harness === "claude-code"
            ? roots.claude
            : harness === "opencode"
              ? roots.opencode
              : undefined,
    },
    originalsPath: join(home, "originals"),
  };
  const transport: Layer.Layer<HttpClient.HttpClient> = input.transport
    ? fetchTestClientLayer(input.transport)
    : FetchHttpClient.layer;
  const registryAuth = registryAuthAccessLayer({
    authState: Result.succeed({
      ...(input.registryBaseUrl === undefined ? {} : { origin: input.registryBaseUrl }),
      ...(input.registryToken === undefined ? {} : { token: input.registryToken }),
      source: input.registryToken === undefined ? "none" : "stored",
    }),
    ...(input.registryBaseUrl === undefined ? {} : { origin: input.registryBaseUrl }),
    ...(input.registryToken === undefined ? {} : { token: input.registryToken }),
  });
  const owned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          libraryStoreLayer({ home }),
          libraryAuditLogLayer({ home }),
          transport,
          registryHttpLayer(transport),
          registryAuth,
          treeHasherLayer,
        ),
      ),
    ) as Effect.Effect<
      A,
      E,
      | Exclude<
          R,
          LibraryStore | LibraryAuditLog | HttpClient.HttpClient | RegistryHttp | TreeHasher
        >
      | FileSystem.FileSystem
    >;
  const durable = owned(Effect.flatMap(LibraryStore, (store) => store.load));
  const writeDurable = (state: LibraryState) =>
    fs.writeFileString(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return {
    home,
    harnessRoot,
    roots,
    now,
    statePath,
    originals: addOptions.originalsPath,
    inventory,
    bindings,
    addOptions,
    owned,
    durable,
    writeDurable,
    projection: (harness: HarnessName, ...segments: string[]) =>
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

export const bindInitializedSkitEffect = Effect.fn("Test.bindInitializedSkit")(function* (
  root: string,
  namespace: string,
  origin = "https://registry.example",
) {
  const fs = yield* FileSystem.FileSystem;
  const descriptor = yield* readSkitDescriptorEffect(root);
  yield* fs.writeFileString(
    join(root, "skit.remote.json"),
    `${JSON.stringify({ schema: "skit.remote.v1", origin, namespace, skit: descriptor.slug })}\n`,
  );
});

export const boundSkit = Effect.fn("Test.boundSkit")(function* (path: string, namespace: string) {
  yield* initSkitEffect(path);
  yield* bindInitializedSkitEffect(path, namespace);
  return path;
});

export const releaseIdentity = (source: string, release: string) =>
  validateSkitDirectoryEffect(source, release, { assessmentContext: "retain" }).pipe(
    Effect.map((validated) => validated.identity),
  );

export const archiveBytes = Effect.fn("Test.archiveBytes")(function* (
  source: string,
  archivePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* createSkitArchiveEffect(source, archivePath);
  return yield* fs.readFile(archivePath);
});

export const serveArchive =
  (bytes: () => Uint8Array): typeof globalThis.fetch =>
  async () =>
    new Response(new Uint8Array(bytes()), { headers: { "content-type": "application/zip" } });

export const noTransport =
  (reason: string): typeof globalThis.fetch =>
  async () => {
    throw new Error(reason);
  };

export { deterministicTreeHashEffect };

/** Retain observed bytes into the Library at `home`, through the store production consumes. */
export const retainObservedIn =
  (home: string) => (request: Parameters<typeof retainObservedCollectionEffect>[0]) =>
    retainObservedCollectionEffect(request).pipe(Effect.provide(libraryStoreLayer({ home })));

/** Mutate the Library at `home` the way a front end does: under the recording writer lock. */
export const writingTo = <A, E, R>(home: string, effect: Effect.Effect<A, E, R>) =>
  withLibraryWriter(effect).pipe(Effect.provide(libraryStoreLayer({ home })));
