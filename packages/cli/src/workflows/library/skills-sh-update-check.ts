import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Clock, Effect, FileSystem, Result, Schema } from "effect";
import {
  LibraryStore,
  retainedTreePath,
  SourceProcess,
  type LibraryState,
} from "@smolai/skit-core";
import { computeSkillsShCompatibleHash } from "./skills-sh-compatible-hash.js";
import type { LibrarySubject } from "./subject-resolution.js";

export type SkillsShUpdateStatus =
  | "current"
  | "update-available"
  | "removed-upstream"
  | "lock-stale"
  | "differs-from-lock-and-upstream"
  | "unverifiable"
  | "not-applicable";

export interface SkillsShUpdateMember {
  readonly skill_name: string;
  readonly skill_path?: string;
  readonly hash_kind?: "computedHash" | "skillFolderHash";
  readonly status: SkillsShUpdateStatus;
  readonly baseline_commit?: string;
  readonly baseline_tree?: string;
  readonly baseline_verification?: "lock-only" | "lock+retained-bytes";
  readonly upstream_commit?: string;
  readonly upstream_tree?: string;
  readonly reason?: string;
}

export class GitInspectionFailed extends Schema.TaggedError<GitInspectionFailed>()(
  "SkillsSh.GitInspectionFailed",
  { operation: Schema.String },
) {}

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

const sourceUrl = (
  subject: LibrarySubject,
  observations: readonly LibraryState["acquisitions"][number]["observations"][number][],
) => {
  const upstream =
    subject.kind === "collection" ? subject.collection.upstream : subject.skill.upstream;
  const source = upstream?.source_identity;
  if (source?.kind === "github")
    return `https://github.com/${source.owner}/${source.repository}.git`;
  if (source?.kind === "git") return source.remote.value;
  return observations.find((observation) => observation.source_url)?.source_url;
};

export const checkSkillsShSubjectEffect = Effect.fn("SkillsSh.checkSubject")(function* (
  subject: LibrarySubject,
  acquisition: LibraryState["acquisitions"][number] | undefined,
  retainedCopy: LibraryState["retained_copies"][number] | undefined,
) {
  if (!acquisition || !retainedCopy) return undefined;
  const checkedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const store = yield* LibraryStore;
  const observations = [
    ...new Map(
      acquisition.observations.flatMap((observation) =>
        observation.type === "skills.sh-lock"
          ? [
              [
                `${observation.skill_name}\0${observation.skill_path ?? ""}\0${observation.computed_hash ?? ""}\0${observation.skill_folder_hash ?? ""}`,
                observation,
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ];
  if (!observations.length) return undefined;
  const source = sourceUrl(subject, observations);
  if (!source)
    return {
      checked_at: checkedAt,
      members: observations.map((observation): SkillsShUpdateMember => ({
        skill_name: observation.skill_name,
        ...(observation.skill_path ? { skill_path: observation.skill_path } : {}),
        status: observation.source_type === "well-known" ? "not-applicable" : "unverifiable",
        reason:
          observation.source_type === "well-known"
            ? "well-known source"
            : "source is not a Git repository",
      })),
    };
  const mirror = yield* Effect.result(
    ensureMirror(join(store.home, "cache", "skills-sh-sources"), source),
  );
  if (Result.isFailure(mirror))
    return {
      checked_at: checkedAt,
      members: observations.map((observation): SkillsShUpdateMember => ({
        skill_name: observation.skill_name,
        ...(observation.skill_path ? { skill_path: observation.skill_path } : {}),
        status: "unverifiable",
        reason: "could not reach Git source",
      })),
    };
  const ref = observations.find((observation) => observation.ref)?.ref ?? "HEAD";
  const tipResult = yield* Effect.result(gitText(mirror.success, ["rev-parse", `${ref}^{commit}`]));
  if (Result.isFailure(tipResult))
    return {
      checked_at: checkedAt,
      members: observations.map((observation): SkillsShUpdateMember => ({
        skill_name: observation.skill_name,
        ...(observation.skill_path ? { skill_path: observation.skill_path } : {}),
        status: "unverifiable",
        reason: `could not resolve ref ${ref}`,
      })),
    };
  const tip = tipResult.success.trim();
  const root = retainedTreePath(store.originalsPath, retainedCopy.digest);
  const members: SkillsShUpdateMember[] = [];
  for (const observation of observations) {
    const claimed = observation.computed_hash ?? observation.skill_folder_hash;
    const kind = observation.computed_hash
      ? ("computedHash" as const)
      : observation.skill_folder_hash
        ? ("skillFolderHash" as const)
        : undefined;
    const base = {
      skill_name: observation.skill_name,
      ...(observation.skill_path ? { skill_path: observation.skill_path } : {}),
      ...(kind ? { hash_kind: kind } : {}),
      upstream_commit: tip,
    };
    if (!observation.skill_path || !claimed || !kind) {
      members.push({ ...base, status: "unverifiable", reason: "lock has no Skill path or hash" });
      continue;
    }
    const folder = dirname(observation.skill_path).replaceAll("\\", "/");
    const tipState = yield* hashAt(mirror.success, tip, folder, kind);
    if (!tipState) {
      const commits = (yield* gitText(mirror.success, ["log", "--format=%H", tip, "--", folder]))
        .trim()
        .split("\n")
        .filter(Boolean);
      let baseline: { commit: string; tree: string } | undefined;
      for (const commit of commits) {
        const candidate = yield* hashAt(mirror.success, commit, folder, kind);
        if (candidate?.hash === claimed) {
          baseline = { commit, tree: candidate.tree };
          break;
        }
      }
      members.push({
        ...base,
        ...(baseline
          ? {
              baseline_commit: baseline.commit,
              baseline_tree: baseline.tree,
              baseline_verification:
                kind === "computedHash" && observation.content_agreement === "agrees"
                  ? ("lock+retained-bytes" as const)
                  : ("lock-only" as const),
            }
          : {}),
        status: baseline ? "removed-upstream" : "unverifiable",
        ...(baseline ? {} : { reason: "lock hash not found in searched ref history" }),
      });
      continue;
    }
    if (kind === "skillFolderHash") {
      let baseline = tipState.hash === claimed ? { commit: tip, tree: tipState.tree } : undefined;
      if (!baseline) {
        const commits = (yield* gitText(mirror.success, ["log", "--format=%H", tip, "--", folder]))
          .trim()
          .split("\n")
          .filter(Boolean);
        for (const commit of commits) {
          const candidate = yield* hashAt(mirror.success, commit, folder, kind);
          if (candidate?.hash === claimed) {
            baseline = { commit, tree: candidate.tree };
            break;
          }
        }
      }
      members.push({
        ...base,
        upstream_tree: tipState.tree,
        ...(baseline
          ? {
              baseline_commit: baseline.commit,
              baseline_tree: baseline.tree,
              baseline_verification: "lock-only" as const,
            }
          : {}),
        status: "unverifiable",
        reason: baseline
          ? "Git tree hash cannot verify retained filesystem bytes"
          : "lock tree hash not found in searched ref history",
      });
      continue;
    }
    const local = yield* computeSkillsShCompatibleHash(join(root, folder), join(root, folder));
    if (!local) {
      members.push({
        ...base,
        upstream_tree: tipState.tree,
        status: "unverifiable",
        reason: "retained Skill bytes are unavailable",
      });
      continue;
    }
    if (local === claimed && tipState.hash === claimed) {
      members.push({
        ...base,
        upstream_tree: tipState.tree,
        baseline_commit: tip,
        baseline_tree: tipState.tree,
        baseline_verification: "lock+retained-bytes",
        status: "current",
      });
      continue;
    }
    if (local !== claimed) {
      members.push({
        ...base,
        upstream_tree: tipState.tree,
        status: tipState.hash === local ? "lock-stale" : "differs-from-lock-and-upstream",
      });
      continue;
    }
    const commits = (yield* gitText(mirror.success, ["log", "--format=%H", tip, "--", folder]))
      .trim()
      .split("\n")
      .filter(Boolean);
    let baseline: { commit: string; tree: string } | undefined;
    const seenTrees = new Set<string>();
    for (const commit of commits) {
      const candidate = yield* hashAt(mirror.success, commit, folder, kind);
      if (!candidate || seenTrees.has(candidate.tree)) continue;
      seenTrees.add(candidate.tree);
      if (candidate.hash === claimed) {
        baseline = { commit, tree: candidate.tree };
        break;
      }
    }
    members.push({
      ...base,
      upstream_tree: tipState.tree,
      ...(baseline ? { baseline_commit: baseline.commit, baseline_tree: baseline.tree } : {}),
      ...(baseline ? { baseline_verification: "lock+retained-bytes" as const } : {}),
      status: baseline ? "update-available" : "unverifiable",
      ...(baseline ? {} : { reason: "lock hash not found in searched ref history" }),
    });
  }
  return { checked_at: checkedAt, members };
});
