import { join, matchesGlob, posix, sep } from "node:path";
import { Effect, FileSystem, Result, Schema } from "effect";
import type { SetupRepositoryConfig } from "./setup-contract.js";

const RepositoryRelativeGlob = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))(?!!).+$/u),
);
const RepositoryRelativeDirectory = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))[^*?[\]{}!]+$/u),
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
