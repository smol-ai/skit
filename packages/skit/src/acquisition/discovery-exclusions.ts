import { Effect, FileSystem, Result, Schema } from "effect";
import { join, matchesGlob, posix, sep } from "node:path";

const RepositoryConfigExclusions = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal("skit.config.v1"),
    discovery: Schema.Struct({ exclude: Schema.Array(Schema.String) }),
  }),
);

/**
 * Whether a repository-relative path is excluded by `skit.config.json` `discovery.exclude`. A
 * pattern matches as a glob, and a literal directory also excludes everything beneath it. Setup's
 * repository scan and `skit add` discovery share this rule, so a repository's own fixtures stay out
 * of both.
 */
export const discoveryPathExcluded = (exclude: readonly string[], path: string): boolean => {
  const relativePath = path.split(sep).join(posix.sep).replace(/^\.\//, "");
  return exclude.some((pattern) => {
    const directory = pattern.replace(/\/+$/, "");
    const literalDirectory = !/[*?[\]{}]/.test(directory);
    return (
      matchesGlob(relativePath, pattern) ||
      (literalDirectory && (relativePath === directory || relativePath.startsWith(`${directory}/`)))
    );
  });
};

/**
 * The exclusions a source declares at its root. A missing or unreadable config excludes nothing:
 * discovery then finds more, never less, than the source declares.
 */
export const readDiscoveryExclusions = Effect.fn("Sources.readDiscoveryExclusions")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(join(root, "skit.config.json"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (text === undefined) return [];
  const decoded = Schema.decodeUnknownResult(RepositoryConfigExclusions)(text);
  return Result.isSuccess(decoded) ? decoded.success.discovery.exclude : [];
});
