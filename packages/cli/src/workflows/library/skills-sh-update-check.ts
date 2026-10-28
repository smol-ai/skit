import { dirname, join } from "node:path";
import { Clock, Effect } from "effect";
import { LibraryStore, collectionVersionPath, type LibraryState } from "@smolai/skit-core";
import { computeSkillsShCompatibleHash } from "./skills-sh-compatible-hash.js";
import type { LibrarySubject } from "./subject-resolution.js";
import { inspectSkillsShGitEvidence } from "./skills-sh-git-evidence.js";
export { GitInspectionFailed } from "./skills-sh-git-evidence.js";

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

const sourceUrl = (
  subject: LibrarySubject,
  observations: readonly LibraryState["imports"][number]["lock_file_entries"][number][],
) => {
  const upstream = subject.kind === "collection" ? subject.collection.upstream : undefined;
  const source = upstream?.source_identity;
  if (source?.kind === "github")
    return `https://github.com/${source.owner}/${source.repository}.git`;
  if (source?.kind === "git") return source.remote.value;
  return observations.find((observation) => observation.source_url)?.source_url;
};

export const checkSkillsShSubject = Effect.fn("SkillsSh.checkSubject")(function* (
  subject: LibrarySubject,
  acquisition: LibraryState["imports"][number] | undefined,
  retainedCopy: LibraryState["collection_versions"][number] | undefined,
) {
  if (!acquisition || !retainedCopy) return undefined;
  const checkedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const store = yield* LibraryStore;
  const observations = [
    ...new Map(
      acquisition.lock_file_entries.flatMap((observation) =>
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
  const ref = observations.find((observation) => observation.ref)?.ref ?? "HEAD";
  const evidence = yield* inspectSkillsShGitEvidence(store.home, source, ref);
  if (evidence._tag === "Unavailable")
    return {
      checked_at: checkedAt,
      members: observations.map((observation): SkillsShUpdateMember => ({
        skill_name: observation.skill_name,
        ...(observation.skill_path ? { skill_path: observation.skill_path } : {}),
        status: "unverifiable",
        reason: evidence.reason,
      })),
    };
  const tip = evidence.commit;
  const root = collectionVersionPath(store.originalsPath, retainedCopy.digest);
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
    const member = yield* evidence.member(folder, kind, claimed);
    const tipState = member.tip;
    if (!tipState) {
      const baseline = yield* member.baseline;
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
      const baseline = yield* member.baseline;
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
    const baseline = yield* member.baseline;
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
