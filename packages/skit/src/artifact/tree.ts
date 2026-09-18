import { Effect, FileSystem, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { posix, sep } from "node:path";
import { isCollectionControlRootEntry } from "./control-files.js";
import { LinkStat } from "../platform/link-stat.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
import { TreeError } from "../shared/tree-error.js";
import { SourceProcess, type SourceProcessFailure } from "../platform/source-process.js";

export type TreePolicy = "normalized" | "verbatim";
export const TreeEntry = Schema.Union([
  Schema.Struct({ path: Schema.String, kind: Schema.Literal("directory") }),
  Schema.Struct({
    path: Schema.String,
    kind: Schema.Literal("file"),
    mode: Schema.Literals([0o644, 0o755]),
    bytes: Schema.Uint8Array,
  }),
  Schema.Struct({ path: Schema.String, kind: Schema.Literal("symlink"), target: Schema.String }),
]);
export type TreeEntry = typeof TreeEntry.Type;

export const TreeExcludedObservation = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["directory", "file", "symlink"]),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  opaque: Schema.Boolean,
  reason: Schema.Literals(["gitignored", "normalized-control-exclusion"]),
});
export interface TreeExcludedObservation extends Schema.Schema.Type<
  typeof TreeExcludedObservation
> {}

export const NormalizedTreeInspection = Schema.Struct({
  entries: Schema.Array(TreeEntry),
  excluded: Schema.Array(TreeExcludedObservation),
});
export interface NormalizedTreeInspection extends Schema.Schema.Type<
  typeof NormalizedTreeInspection
> {}

/**
 * Run git and return stdout, failing when it exits non-zero.
 *
 * The process service captures stdout but does not interpret the exit code, which would turn an
 * unqueryable worktree into an empty file list if it were ignored. Git rules must fail closed.
 */
function gitOutput(
  args: readonly string[],
): Effect.Effect<string, SourceProcessFailure | TreeError, SourceProcess> {
  return Effect.gen(function* () {
    const process = yield* SourceProcess;
    const result = yield* process.output("git", args);
    if (result.exitCode !== 0)
      return yield* new TreeError({
        reason: {
          _tag: "GitCommandFailed",
          command: `git ${args.join(" ")}`,
          exitCode: result.exitCode,
        },
      });
    return new TextDecoder().decode(result.stdout);
  });
}

function gitWorktreeRoot(
  root: string,
): Effect.Effect<string | undefined, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let candidate = root;
    while (true) {
      if (yield* fs.exists(path.join(candidate, ".git"))) return candidate;
      const parent = path.dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  });
}

function gitIncludedPaths(
  root: string,
): Effect.Effect<Set<string> | undefined, TreeError, TreeRequirements> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const process = yield* SourceProcess;

    const collected = yield* Effect.gen(function* () {
      const worktreeRoot = yield* gitWorktreeRoot(root);
      if (!worktreeRoot) return undefined;
      const stdout = yield* gitOutput([
        "-C",
        root,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
      ]);
      const staged = yield* gitOutput(["-C", root, "ls-files", "--stage", "-z", "--", "."]);
      let rootIgnored = false;
      if (root !== worktreeRoot) {
        const relativeRoot = path.relative(worktreeRoot, root).split(sep).join(posix.sep);
        const result = yield* process.run("git", [
          "-C",
          worktreeRoot,
          "check-ignore",
          "--quiet",
          "--no-index",
          "--",
          relativeRoot,
        ]);
        rootIgnored = result.exitCode === 0;
      }
      return { stdout, staged, rootIgnored };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TreeError({
            reason: {
              _tag: "GitInspectionFailed",
              detail: cause instanceof Error ? cause.message : String(cause),
            },
          }),
      ),
    );
    if (!collected) return undefined;

    const paths = collected.stdout.split("\0").filter(Boolean);
    const untrackedRepository = paths.find((entry) => entry.endsWith("/"));
    if (untrackedRepository)
      return yield* new TreeError({
        reason: { _tag: "EmbeddedRepository", path: untrackedRepository.slice(0, -1) },
      });
    const submodule = collected.staged
      .split("\0")
      .filter(Boolean)
      .find((entry) => entry.startsWith("160000 "))
      ?.split("\t", 2)[1];
    if (submodule)
      return yield* new TreeError({
        reason: { _tag: "Submodule", path: submodule },
      });
    if (collected.rootIgnored)
      return yield* new TreeError({
        reason: { _tag: "IgnoredRoot" },
      });
    if (paths.length === 0) return yield* new TreeError({ reason: { _tag: "FullyExcludedRoot" } });
    return new Set(paths.map((entry) => entry.split(sep).join(posix.sep).normalize("NFC")));
  });
}

/** Normalized trees are publishable content; verbatim trees preserve lossless source details. */
export function walkTreeEffect(
  root: string,
  policy: TreePolicy,
  options: { respectGitIgnore?: boolean } = {},
): Effect.Effect<TreeEntry[], TreeError | PlatformError, TreeRequirements> {
  if (policy === "normalized")
    return walkTreeInternal(root, policy, { ...options, observeExcluded: false }).pipe(
      Effect.map((inspection) => [...inspection.entries]),
    );
  return walkTreeInternal(root, policy, { ...options, observeExcluded: false }).pipe(
    Effect.map((inspection) => [...inspection.entries]),
  );
}

/** Inspect publish-shaped membership while retaining diagnostic evidence about omitted content. */
export function inspectNormalizedTreeEffect(
  root: string,
  options: { respectGitIgnore?: boolean } = {},
): Effect.Effect<NormalizedTreeInspection, TreeError | PlatformError, TreeRequirements> {
  return walkTreeInternal(root, "normalized", { ...options, observeExcluded: true });
}

function walkTreeInternal(
  root: string,
  policy: TreePolicy,
  options: { respectGitIgnore?: boolean; observeExcluded: boolean },
): Effect.Effect<NormalizedTreeInspection, TreeError | PlatformError, TreeRequirements> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const links = yield* LinkStat;

    // Published trees canonicalize their root and paths. Verbatim trees intentionally
    // retain the caller's lexical root and filename normalization for lossless identity.
    const canonicalRoot = policy === "normalized" ? yield* fs.realPath(root) : path.resolve(root);
    const includedPaths =
      policy === "normalized" && options.respectGitIgnore
        ? yield* gitIncludedPaths(canonicalRoot)
        : undefined;
    const includedDirectories = new Set<string>();
    for (const included of includedPaths ?? []) {
      let parent = posix.dirname(included);
      while (parent !== ".") {
        includedDirectories.add(parent);
        parent = posix.dirname(parent);
      }
    }

    const entries: TreeEntry[] = [];
    const excluded: TreeExcludedObservation[] = [];
    const recordExcluded = (
      absolute: string,
      entryPath: string,
      reason: TreeExcludedObservation["reason"],
    ): Effect.Effect<void, PlatformError, never> =>
      Effect.gen(function* () {
        const info = yield* links.lstat(absolute);
        excluded.push({
          path: entryPath,
          kind:
            info.type === "Directory"
              ? "directory"
              : info.type === "SymbolicLink"
                ? "symlink"
                : "file",
          bytes: info.type === "File" ? Number(info.size) : 0,
          opaque: info.type === "Directory",
          reason,
        });
      });
    const walk = (
      directory: string,
      depth: number,
    ): Effect.Effect<void, TreeError | PlatformError, never> =>
      Effect.gen(function* () {
        for (const name of (yield* fs.readDirectory(directory)).sort()) {
          const absolute = path.resolve(directory, name);
          const relativePath = path.relative(canonicalRoot, absolute).split(sep).join(posix.sep);
          const entryPath = policy === "normalized" ? relativePath.normalize("NFC") : relativePath;
          if (!entryPath || entryPath.startsWith("../") || posix.isAbsolute(entryPath))
            return yield* new TreeError({ reason: { _tag: "EscapedPath", path: entryPath } });
          const controlExcluded =
            (policy === "normalized" &&
              ([".DS_Store", ".skit-ownership.json", ".git"].includes(name) ||
                isCollectionControlRootEntry(name, depth))) ||
            (policy === "normalized" && depth === 0 && name === "skit.remote.json") ||
            (policy === "verbatim" &&
              ((depth === 0 && name === ".git") || isCollectionControlRootEntry(name, depth)));
          if (controlExcluded) {
            if (policy === "normalized" && options.observeExcluded)
              yield* recordExcluded(absolute, entryPath, "normalized-control-exclusion");
            continue;
          }
          if (
            includedPaths &&
            !includedPaths.has(entryPath) &&
            !includedDirectories.has(entryPath)
          ) {
            if (options.observeExcluded) yield* recordExcluded(absolute, entryPath, "gitignored");
            continue;
          }
          const info = yield* links.lstat(absolute);
          if (info.type === "SymbolicLink") {
            if (policy === "normalized")
              return yield* new TreeError({
                reason: { _tag: "InvalidSymlink", path: entryPath },
              });
            entries.push({
              path: entryPath,
              kind: "symlink",
              target: yield* fs.readLink(absolute),
            });
          } else if (info.type === "Directory") {
            if (policy === "verbatim") entries.push({ path: entryPath, kind: "directory" });
            yield* walk(absolute, depth + 1);
          } else if (info.type === "File")
            entries.push({
              path: entryPath,
              kind: "file",
              mode: info.mode & 0o111 ? 0o755 : 0o644,
              bytes: Buffer.from(yield* fs.readFile(absolute)),
            });
          else
            return yield* new TreeError({
              reason: { _tag: "UnsupportedEntry", path: entryPath },
            });
        }
      }) as Effect.Effect<void, TreeError | PlatformError, never>;

    yield* walk(canonicalRoot, 0);
    return { entries, excluded };
  });
}
