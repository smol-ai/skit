import { hostname } from "node:os";
import { join, matchesGlob, posix, resolve, sep } from "node:path";
import { Effect, FileSystem, Result, Schema } from "effect";
import {
  MachineDocumentJson,
  MachineDocumentV4,
  makeMachineId,
  writeJsonAtomicEffect,
  type CurrentMachineDocument,
} from "@smolai/skit-core";
import { isErrno } from "../../platform/errno.js";
import type { SetupRepositoryConfig } from "./setup-contract.js";
const MACHINE_CONFIG_FILE = "machine.json";

const RepositoryRelativeGlob = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))(?!!).+$/),
);
const RepositoryRelativeDirectory = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))[^*?[\]{}!]+$/),
);
const RepositoryConfigHeader = Schema.fromJsonString(Schema.Struct({ schema: Schema.String }));
const RepositoryConfigDocument = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal("skit.config.v1"),
    discovery: Schema.Struct({
      exclude: Schema.Array(RepositoryRelativeGlob),
      collections: Schema.Array(Schema.Struct({ path: RepositoryRelativeDirectory })),
    }),
  }),
);

export class SetupConfigUnusable extends Schema.TaggedError<SetupConfigUnusable>()(
  "SetupConfigUnusable",
  { path: Schema.String },
) {
  get message() {
    return `SKIT machine configuration is invalid: ${this.path}`;
  }
}

const machineConfigPath = (home: string) => join(resolve(home), MACHINE_CONFIG_FILE);

export const setupDiscoveryRoots = (config: CurrentMachineDocument): readonly string[] =>
  config.discoveryRoots;

export const setupRepositoryDecisions = (
  config: CurrentMachineDocument,
): readonly { path: string; status: "watched" | "ignored" }[] => config.repositories;

export const readSetupMachineConfig = Effect.fn("Setup.readMachineConfig")(function* (
  libraryHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = machineConfigPath(libraryHome);
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        isErrno(error, "ENOENT")
          ? Effect.succeed(undefined)
          : Effect.fail(new SetupConfigUnusable({ path })),
      ),
    );
  if (text === undefined)
    return {
      path,
      schemaVersion: 4 as const,
      discoveryRoots: [],
      repositories: [],
      repositoryDecisionsInitialized: false,
    };
  return yield* Schema.decodeUnknownEffect(MachineDocumentJson)(text).pipe(
    Effect.mapError(() => new SetupConfigUnusable({ path })),
    Effect.map((config) => ({ path, ...config })),
  );
});

export const writeSetupMachineConfig = Effect.fn("Setup.writeMachineConfig")(function* (
  libraryHome: string,
  discoveryRoots: readonly string[],
  repositories: readonly { path: string; status: "watched" | "ignored" }[],
  prior: CurrentMachineDocument,
  displayName: string,
) {
  const path = machineConfigPath(libraryHome);
  const config = yield* MachineDocumentV4.makeEffect({
    schemaVersion: 4,
    machineId: prior.machineId ?? makeMachineId(),
    displayName: prior.displayName ?? displayName,
    discoveryRoots: [...discoveryRoots],
    repositories: [...repositories],
  });
  yield* writeJsonAtomicEffect(path, config);
  return { path, ...config };
});

export const updateSetupRepositoryDecision = Effect.fn("Setup.updateRepositoryDecision")(function* (
  libraryHome: string,
  repository: string,
  status: "watched" | "ignored" | undefined,
) {
  const prior = yield* readSetupMachineConfig(libraryHome);
  const path = resolve(repository);
  const decisions = new Map(
    setupRepositoryDecisions(prior).map((decision) => [resolve(decision.path), decision.status]),
  );
  if (status === undefined) decisions.delete(path);
  else decisions.set(path, status);
  return yield* writeSetupMachineConfig(
    libraryHome,
    setupDiscoveryRoots(prior),
    [...decisions]
      .map(([decisionPath, decisionStatus]) => ({
        path: decisionPath,
        status: decisionStatus,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    prior,
    hostname(),
  );
});

export const readRepositoryConfig = Effect.fn("Setup.readRepositoryConfig")(function* (
  repository: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(repository, "skit.config.json");
  const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => undefined));
  if (text === undefined)
    return {
      repository,
      path,
      status: "missing" as const,
      exclude: [] as string[],
      collections: [] as Array<{ path: string }>,
    };
  const header = Schema.decodeUnknownResult(RepositoryConfigHeader)(text);
  if (Result.isFailure(header))
    return {
      repository,
      path,
      status: "malformed" as const,
      exclude: [] as string[],
      collections: [] as Array<{ path: string }>,
    };
  if (header.success.schema !== "skit.config.v1")
    return {
      repository,
      path,
      status: "unsupported" as const,
      schema: header.success.schema,
      exclude: [] as string[],
      collections: [] as Array<{ path: string }>,
    };
  const decoded = Schema.decodeUnknownResult(RepositoryConfigDocument, {
    onExcessProperty: "error",
  })(text);
  if (Result.isFailure(decoded))
    return {
      repository,
      path,
      status: "malformed" as const,
      schema: header.success.schema,
      exclude: [] as string[],
      collections: [] as Array<{ path: string }>,
    };
  return {
    repository,
    path,
    status: "valid" as const,
    schema: decoded.success.schema,
    exclude: [...new Set(decoded.success.discovery.exclude)].sort(),
    collections: [...decoded.success.discovery.collections].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  } satisfies SetupRepositoryConfig;
});

export const repositoryPathExcluded = (config: SetupRepositoryConfig | undefined, path: string) => {
  if (config?.status !== "valid") return false;
  const relativePath = path.split(sep).join(posix.sep).replace(/^\.\//, "");
  return config.exclude.some((pattern) => {
    const directory = pattern.replace(/\/+$/, "");
    const literalDirectory = !/[*?[\]{}]/.test(directory);
    return (
      matchesGlob(relativePath, pattern) ||
      (literalDirectory && (relativePath === directory || relativePath.startsWith(`${directory}/`)))
    );
  });
};
