import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, FileSystem, Result, Schema } from "effect";
import { SourceProcess, FailureTypeId, type SkitFailure } from "@smolai/skit-core";

export class GitInspectionFailed
  extends Schema.TaggedError<GitInspectionFailed>()("SkillsSh.GitInspectionFailed", {
    operation: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check that git is installed and the repository is readable, then retry.";
  get message(): string {
    return `git ${this.operation} failed`;
  }
}

const gitBytes = Effect.fn("SkillsSh.gitBytes")(function* (
  gitDirectory: string | undefined,
  args: readonly string[],
) {
  const process = yield* SourceProcess;
  const gitArgs = [...(gitDirectory ? [`--git-dir=${gitDirectory}`] : []), ...args];
  const result = yield* process
    .output("git", gitArgs)
    .pipe(Effect.mapError(() => new GitInspectionFailed({ operation: args[0] ?? "git" })));
  if (result.exitCode !== 0) return yield* new GitInspectionFailed({ operation: args[0] ?? "git" });
  return result.stdout;
});

const gitText = Effect.fn("SkillsSh.gitText")(function* (
  gitDirectory: string | undefined,
  args: readonly string[],
) {
  return new TextDecoder().decode(yield* gitBytes(gitDirectory, args));
});

const gitTree = Effect.fn("SkillsSh.gitTree")(function* (
  gitDirectory: string,
  commit: string,
  folder: string,
) {
  const result = yield* Effect.result(gitText(gitDirectory, ["rev-parse", `${commit}:${folder}`]));
  return Result.isSuccess(result) ? result.success.trim() || undefined : undefined;
});

const skillsShHashForTree = Effect.fn("SkillsSh.hashGitTree")(function* (
  gitDirectory: string,
  tree: string,
) {
  const records = (yield* gitText(gitDirectory, ["ls-tree", "-r", "-z", tree]))
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const fields = record.slice(0, tab).split(" ");
      return { object: fields[2] ?? "", path: record.slice(tab + 1) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256");
  for (const record of records) {
    hash.update(record.path);
    hash.update(yield* gitBytes(gitDirectory, ["cat-file", "blob", record.object]));
  }
  return hash.digest("hex");
});

const hashAt = Effect.fn("SkillsSh.hashAt")(function* (
  gitDirectory: string,
  commit: string,
  folder: string,
  kind: "computedHash" | "skillFolderHash",
) {
  const tree = yield* gitTree(gitDirectory, commit, folder);
  if (!tree) return undefined;
  return {
    tree,
    hash: kind === "skillFolderHash" ? tree : yield* skillsShHashForTree(gitDirectory, tree),
  };
});

const ensureMirror = Effect.fn("SkillsSh.ensureMirror")(function* (
  cacheRoot: string,
  source: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheRoot, { recursive: true });
  const key = createHash("sha256").update(source).digest("hex");
  const directory = join(cacheRoot, `${key}.git`);
  if (yield* fs.exists(directory))
    yield* gitBytes(directory, ["fetch", "--all", "--prune", "--quiet"]);
  else yield* gitBytes(undefined, ["clone", "--mirror", "--quiet", source, directory]);
  return directory;
});

/** Find the newest matching tree on the selected ref's path history. */
const findBaseline = Effect.fn("SkillsSh.findGitBaseline")(function* (
  directory: string,
  tip: string,
  folder: string,
  kind: "computedHash" | "skillFolderHash",
  claimed: string,
  tipState: { tree: string; hash: string } | undefined,
) {
  if (tipState?.hash === claimed) return { commit: tip, tree: tipState.tree };
  const commits = (yield* gitText(directory, ["log", "--format=%H", tip, "--", folder]))
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const commit of commits) {
    const candidate = yield* hashAt(directory, commit, folder, kind);
    if (candidate?.hash === claimed) return { commit, tree: candidate.tree };
  }
  return undefined;
});

/** A ref-pinned inspection. Callers see evidence, never mirror paths or Git commands. */
export const inspectSkillsShGitEvidence = Effect.fn("SkillsSh.inspectGitEvidence")(function* (
  home: string,
  source: string,
  ref: string,
) {
  const mirror = yield* Effect.result(
    ensureMirror(join(home, "cache", "skills-sh-sources"), source),
  );
  if (Result.isFailure(mirror))
    return { _tag: "Unavailable" as const, reason: "could not reach Git source" };
  const tip = yield* Effect.result(gitText(mirror.success, ["rev-parse", `${ref}^{commit}`]));
  if (Result.isFailure(tip))
    return { _tag: "Unavailable" as const, reason: `could not resolve ref ${ref}` };
  const commit = tip.success.trim();
  return {
    _tag: "Ready" as const,
    commit,
    member: Effect.fn("SkillsSh.inspectGitMember")(function* (
      folder: string,
      kind: "computedHash" | "skillFolderHash",
      claimed: string,
    ) {
      const tip = yield* hashAt(mirror.success, commit, folder, kind);
      return {
        tip,
        // Defer history traversal until status policy needs a matching baseline.
        baseline: findBaseline(mirror.success, commit, folder, kind, claimed, tip),
      };
    }),
  };
});
