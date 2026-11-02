import { Effect, Equivalence, FileSystem, Option, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { isCollectionControlRootEntry } from "./control-files.js";
import { LinkStat } from "../platform/link-stat.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
import { TreeError } from "../shared/tree-error.js";
import { parentDirectories } from "../shared/relative-path.js";
import { SourceProcess, type SourceProcessFailure } from "../platform/source-process.js";
import { AuthorIgnoreRepository, makePlainAuthorIgnore } from "./plain-author-ignore.js";
import { TreeEntry } from "./tree-entry.js";

export type TreePolicy = "normalized" | "verbatim";

export const ExcludedTreeEntry = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["directory", "file", "symlink"]),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  opaque: Schema.Boolean,
  reason: Schema.Literals(["gitignored", "normalized-control-exclusion"]),
});
export interface ExcludedTreeEntry extends Schema.Schema.Type<typeof ExcludedTreeEntry> {}

export const NormalizedTreeInspection = Schema.Struct({
  entries: Schema.Array(TreeEntry),
  excluded: Schema.Array(ExcludedTreeEntry),
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

/** Resolve index spellings without normalizing raw filenames or following leaf symlinks. */
const nativeGitPaths = Effect.fn("Tree.nativeGitPaths")(function* (
  root: string,
  paths: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const links = yield* LinkStat;
  const directories = new Map<string, ReadonlySet<string>>();
  const included = new Set<string>();
  for (const entry of paths) {
    const first = entry.split("/", 1)[0] ?? "";
    if (first === ".git" || isCollectionControlRootEntry(first, 0)) continue;
    let directory = root;
    const parts = entry.split("/");
    for (const [index, name] of parts.entries()) {
      const names = directories.get(directory) ?? new Set(yield* fs.readDirectory(directory));
      directories.set(directory, names);
      let nativeName: string | undefined = names.has(name) ? name : undefined;
      if (nativeName === undefined) {
        const requested = yield* links.identity
          .lstat(path.join(directory, name))
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));
        if (requested === undefined) break; // A tracked path can have been deleted.
        for (const candidate of names) {
          if (candidate.normalize("NFC").toLowerCase() !== name.normalize("NFC").toLowerCase())
            continue;
          const actual = yield* links.identity.lstat(path.join(directory, candidate));
          if (!sameNativeIdentity(actual, requested)) continue;
          if (nativeName !== undefined)
            return yield* new TreeError({
              reason: {
                _tag: "GitInspectionFailed",
                detail: `Ambiguous native filename for ${entry}`,
              },
            });
          nativeName = candidate;
        }
      }
      if (nativeName === undefined) break;
      const absolute = path.join(directory, nativeName);
      const relativePath = path.relative(root, absolute).split(path.sep).join("/");
      if (index === parts.length - 1) {
        included.add(relativePath);
        break;
      }
      if (
        !directories.has(absolute) &&
        (yield* links.identity.lstat(absolute)).type !== "Directory"
      ) {
        // Preserve a file/symlink that replaced a tracked directory, without following it.
        included.add(relativePath);
        break;
      }
      directory = absolute;
    }
  }
  return included;
});

function gitIncludedPaths(
  root: string,
  policy: TreePolicy,
): Effect.Effect<Set<string> | undefined, TreeError | PlatformError, TreeRequirements> {
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
        const relativeRoot = path.relative(worktreeRoot, root).split(path.sep).join("/");
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
    const relativePaths = paths.map((entry) => entry.split(path.sep).join("/"));
    return policy === "verbatim"
      ? yield* nativeGitPaths(root, relativePaths)
      : new Set(relativePaths.map((entry) => entry.normalize("NFC")));
  });
}

/** Artifact controls are excluded at the same boundary for live captured inputs and tree walks. */
export function isNormalizedTreeControlPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return (
    parts.some((name) => [".DS_Store", ".skit-ownership.json", ".git"].includes(name)) ||
    isCollectionControlRootEntry(parts[0] ?? "", 0) ||
    parts[0] === "skit.remote.json"
  );
}

/** Normalized trees are publishable content; verbatim trees preserve lossless source details. */
export function walkTree(
  root: string,
  policy: TreePolicy,
  options: { respectGitIgnore?: boolean } = {},
): Effect.Effect<TreeEntry[], TreeError | PlatformError, TreeRequirements> {
  if (policy === "normalized")
    return walkTreeInternal(root, policy, { ...options, reportExcluded: false }).pipe(
      Effect.map((inspection) => [...inspection.entries]),
    );
  return walkTreeInternal(root, policy, { ...options, reportExcluded: false }).pipe(
    Effect.map((inspection) => [...inspection.entries]),
  );
}

/** Which native entry a path is: its device and inode. */
export interface NativeTreeIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** Two observations are of the same native entry when their device and inode agree. */
export const sameNativeIdentity: Equivalence.Equivalence<NativeTreeIdentity> = Equivalence.Struct({
  dev: Equivalence.BigInt,
  ino: Equivalence.BigInt,
});

/** The native entry a stat observed, or none on a filesystem that reports no inode. */
export const nativeIdentityOf = (info: FileSystem.File.Info): Option.Option<NativeTreeIdentity> =>
  Option.map(info.ino, (ino) => ({ dev: info.dev, ino }));

const inspectAuthorTree = Effect.fn("Tree.inspectAuthor")(function* (
  root: string,
  recordIdentities: boolean,
) {
  return yield* walkTreeInternal(root, "verbatim", {
    respectGitIgnore: true,
    reportExcluded: false,
    excludeNormalizedControls: true,
    plainAuthorIgnore: yield* AuthorIgnoreRepository,
    recordIdentities,
  });
});

/** Ephemeral native identities accompany the captured bytes; they are not artifact content. */
export const scanAuthorTree = Effect.fn("Tree.scanAuthor")(function* (root: string) {
  const { entries, identities } = yield* inspectAuthorTree(root, true);
  return { entries, identities };
});

export const normalizeAuthorTreeEntries = Effect.fn("Tree.normalizeAuthorEntries")(function* (
  captured: readonly TreeEntry[],
) {
  const entries: TreeEntry[] = [];
  const names = new Set<string>();
  for (const entry of captured) {
    const path = entry.path.normalize("NFC");
    if (entry.kind === "symlink")
      return yield* new TreeError({ reason: { _tag: "InvalidSymlink", path } });
    if (names.has(path))
      return yield* new TreeError({
        reason: { _tag: "CannotRetain", entryType: "ambiguous normalized path", path },
      });
    names.add(path);
    if (entry.kind === "file") entries.push({ ...entry, path });
  }
  return entries;
});

/** One Git/control inventory for local Author history and Draft/retain transport. */
export const walkAuthorTree = Effect.fn("Tree.walkAuthor")(function* (
  root: string,
  policy: TreePolicy,
) {
  const inspection = yield* inspectAuthorTree(root, false);
  return policy === "verbatim"
    ? [...inspection.entries]
    : yield* normalizeAuthorTreeEntries(inspection.entries);
});

/** Inspect publish-shaped membership while retaining diagnostic evidence about omitted content. */
export function inspectNormalizedTree(
  root: string,
  options: { respectGitIgnore?: boolean } = {},
): Effect.Effect<NormalizedTreeInspection, TreeError | PlatformError, TreeRequirements> {
  return walkTreeInternal(root, "normalized", { ...options, reportExcluded: true }).pipe(
    Effect.map(({ entries, excluded }) => ({ entries, excluded })),
  );
}

function walkTreeInternal(
  root: string,
  policy: TreePolicy,
  options: {
    respectGitIgnore?: boolean;
    reportExcluded: boolean;
    excludeNormalizedControls?: boolean;
    plainAuthorIgnore?: AuthorIgnoreRepository["Service"];
    /** Also return each entry's native identity, and fail where one cannot be recorded. */
    recordIdentities?: boolean;
  },
): Effect.Effect<
  NormalizedTreeInspection & {
    readonly identities: ReadonlyMap<string, NativeTreeIdentity>;
  },
  TreeError | PlatformError,
  TreeRequirements
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const links = yield* LinkStat;

    // Published trees canonicalize their root and paths. Verbatim trees intentionally
    // retain the caller's lexical root and filename normalization for lossless identity.
    const canonicalRoot = policy === "normalized" ? yield* fs.realPath(root) : path.resolve(root);
    const identities = new Map<string, NativeTreeIdentity>();
    const remember = (entryPath: string, info: FileSystem.File.Info) =>
      Effect.gen(function* () {
        if (!options.recordIdentities) return;
        const identity = nativeIdentityOf(info);
        if (Option.isNone(identity))
          return yield* new TreeError({
            reason: {
              _tag: "CannotRetain",
              entryType: "entry without native identity",
              path: entryPath,
            },
          });
        identities.set(entryPath, identity.value);
      });
    if (options.recordIdentities) {
      const rootInfo = yield* links.lstat(canonicalRoot);
      if (rootInfo.type !== "Directory")
        return yield* new TreeError({
          reason: { _tag: "CannotRetain", entryType: "non-directory root", path: "." },
        });
      yield* remember("", rootInfo);
    }
    const includedPaths = options.respectGitIgnore
      ? yield* gitIncludedPaths(canonicalRoot, policy)
      : undefined;
    const plainIgnore =
      options.plainAuthorIgnore && includedPaths === undefined
        ? yield* makePlainAuthorIgnore(canonicalRoot).pipe(
            Effect.provideService(AuthorIgnoreRepository, options.plainAuthorIgnore),
          )
        : undefined;
    const includedDirectories = new Set(
      [...(includedPaths ?? [])].flatMap((included) => parentDirectories(included)),
    );

    const entries: TreeEntry[] = [];
    const excluded: ExcludedTreeEntry[] = [];
    const recordExcluded = (
      absolute: string,
      entryPath: string,
      reason: ExcludedTreeEntry["reason"],
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
        const names = (yield* fs.readDirectory(directory)).sort();
        const ignored =
          plainIgnore === undefined
            ? undefined
            : yield* plainIgnore(
                names
                  .map((name) =>
                    path
                      .relative(canonicalRoot, path.join(directory, name))
                      .split(path.sep)
                      .join("/"),
                  )
                  .filter((entry) => !isNormalizedTreeControlPath(entry)),
              );
        for (const name of names) {
          const absolute = path.resolve(directory, name);
          const relativePath = path.relative(canonicalRoot, absolute).split(path.sep).join("/");
          const entryPath = policy === "normalized" ? relativePath.normalize("NFC") : relativePath;
          if (ignored?.has(relativePath)) continue;
          if (!entryPath || entryPath.startsWith("../") || entryPath.startsWith("/"))
            return yield* new TreeError({ reason: { _tag: "EscapedPath", path: entryPath } });
          const controlExcluded =
            ((policy === "normalized" || options.excludeNormalizedControls) &&
              isNormalizedTreeControlPath(entryPath)) ||
            (policy === "verbatim" &&
              ((depth === 0 && name === ".git") || isCollectionControlRootEntry(name, depth)));
          if (controlExcluded) {
            if (policy === "normalized" && options.reportExcluded)
              yield* recordExcluded(absolute, entryPath, "normalized-control-exclusion");
            continue;
          }
          if (
            includedPaths &&
            !includedPaths.has(entryPath) &&
            !includedDirectories.has(entryPath)
          ) {
            if (options.reportExcluded) yield* recordExcluded(absolute, entryPath, "gitignored");
            continue;
          }
          const info = yield* links.lstat(absolute);
          yield* remember(relativePath, info);
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
          } else if (info.type === "File") {
            const bytes = yield* fs.readFile(absolute);
            if (options.recordIdentities) {
              const after = yield* links
                .lstat(absolute)
                .pipe(
                  Effect.mapError((error) =>
                    error.reason._tag === "NotFound"
                      ? new TreeError({ reason: { _tag: "ChangedDuringRead", path: relativePath } })
                      : error,
                  ),
                );
              const unchanged = Option.getOrElse(
                Option.zipWith(nativeIdentityOf(after), nativeIdentityOf(info), sameNativeIdentity),
                () => false,
              );
              if (
                after.type !== "File" ||
                !unchanged ||
                Boolean(after.mode & 0o111) !== Boolean(info.mode & 0o111)
              )
                return yield* new TreeError({
                  reason: { _tag: "ChangedDuringRead", path: relativePath },
                });
            }
            entries.push({
              path: entryPath,
              kind: "file",
              mode: info.mode & 0o111 ? 0o755 : 0o644,
              bytes,
            });
          } else
            return yield* new TreeError({
              reason: { _tag: "UnsupportedEntry", path: entryPath },
            });
        }
      });

    yield* walk(canonicalRoot, 0);
    return { entries, excluded, identities };
  }).pipe(Effect.scoped);
}
