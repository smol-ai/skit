import { dirname, join } from "node:path";
import { Clock, Effect, Result } from "effect";
import { collectionVersionPath } from "../../collection-version.js";
import type { LibraryState } from "../../library-state.js";
import { inspectSkillsShCompatibleHash } from "../../setup/skills-sh/compatible-hash.js";
import type { LibrarySubject } from "../../subject-resolution.js";
import { inspectSkillsShGitEvidence } from "./skills-sh-git-evidence.js";

import type { SkillsShUpdateMember } from "../../check-facts.js";

const sourceUrl = (
  subject: LibrarySubject,
  lockFileEntries: readonly LibraryState["imports"][number]["lock_file_entries"][number][],
) => {
  const upstream = subject.kind === "collection" ? subject.collection.upstream : undefined;
  const source = upstream?.source_identity;
  if (source?.kind === "github")
    return `https://github.com/${source.owner}/${source.repository}.git`;
  if (source?.kind === "git") return source.remote.value;
  return lockFileEntries.find((lockFileEntry) => lockFileEntry.source_url)?.source_url;
};

export const checkSkillsShSubject = Effect.fn("SkillsSh.checkSubject")(function* (
  home: string,
  originalsPath: string,
  subject: LibrarySubject,
  sourceImport: LibraryState["imports"][number] | undefined,
  collectionVersion: LibraryState["collection_versions"][number] | undefined,
) {
  if (!sourceImport || !collectionVersion) return undefined;
  const checkedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const lockFileEntries = [
    ...new Map(
      sourceImport.lock_file_entries.flatMap((lockFileEntry) =>
        lockFileEntry.type === "skills.sh-lock"
          ? [
              [
                `${lockFileEntry.skill_name}\0${lockFileEntry.skill_path ?? ""}\0${lockFileEntry.computed_hash ?? ""}\0${lockFileEntry.skill_folder_hash ?? ""}`,
                lockFileEntry,
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ];
  if (!lockFileEntries.length) return undefined;
  const source = sourceUrl(subject, lockFileEntries);
  if (!source)
    return {
      checked_at: checkedAt,
      members: lockFileEntries.map((lockFileEntry): SkillsShUpdateMember => ({
        skill_name: lockFileEntry.skill_name,
        ...(lockFileEntry.skill_path ? { skill_path: lockFileEntry.skill_path } : {}),
        status: lockFileEntry.source_type === "well-known" ? "not-applicable" : "unverifiable",
        reason:
          lockFileEntry.source_type === "well-known"
            ? { _tag: "WellKnownSource" }
            : { _tag: "GitSourceMissing" },
      })),
    };
  const ref = lockFileEntries.find((lockFileEntry) => lockFileEntry.ref)?.ref ?? "HEAD";
  const evidence = yield* inspectSkillsShGitEvidence(home, source, ref);
  if (evidence._tag === "Unavailable")
    return {
      checked_at: checkedAt,
      members: lockFileEntries.map((lockFileEntry): SkillsShUpdateMember => ({
        skill_name: lockFileEntry.skill_name,
        ...(lockFileEntry.skill_path ? { skill_path: lockFileEntry.skill_path } : {}),
        status: "unverifiable",
        reason: evidence.reason,
      })),
    };
  const tip = evidence.commit;
  const root = collectionVersionPath(originalsPath, collectionVersion.hash);
  const members: SkillsShUpdateMember[] = [];
  for (const lockFileEntry of lockFileEntries) {
    const claimed = lockFileEntry.computed_hash ?? lockFileEntry.skill_folder_hash;
    const kind = lockFileEntry.computed_hash
      ? ("computedHash" as const)
      : lockFileEntry.skill_folder_hash
        ? ("skillFolderHash" as const)
        : undefined;
    const base = {
      skill_name: lockFileEntry.skill_name,
      ...(lockFileEntry.skill_path ? { skill_path: lockFileEntry.skill_path } : {}),
      ...(kind ? { hash_kind: kind } : {}),
      upstream_commit: tip,
    };
    if (!lockFileEntry.skill_path || !claimed || !kind) {
      members.push({
        ...base,
        status: "unverifiable",
        reason: {
          _tag: "LockIncomplete",
          missing: [
            ...(!lockFileEntry.skill_path ? ["skill-path" as const] : []),
            ...(!claimed || !kind ? ["hash" as const] : []),
          ],
        },
      });
      continue;
    }
    const folder = dirname(lockFileEntry.skill_path).replaceAll("\\", "/");
    const checked = yield* Effect.result(
      Effect.gen(function* () {
        const member = yield* evidence.member(folder, kind, claimed);
        const tipState = member.tip;
        if (!tipState) {
          const baseline = yield* member.baseline;
          return {
            ...base,
            ...(baseline
              ? {
                  baseline_commit: baseline.commit,
                  baseline_tree: baseline.tree,
                  baseline_verification:
                    kind === "computedHash" && lockFileEntry.content_agreement === "agrees"
                      ? ("lock+original-bytes" as const)
                      : ("lock-only" as const),
                }
              : {}),
            status: baseline ? "removed-upstream" : "unverifiable",
            ...(baseline
              ? {}
              : { reason: { _tag: "BaselineNotFound" as const, hashKind: kind, ref } }),
          } satisfies SkillsShUpdateMember;
        }
        if (kind === "skillFolderHash") {
          const baseline = yield* member.baseline;
          return {
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
              ? { _tag: "TreeHashCannotVerifyOriginalBytes" }
              : { _tag: "BaselineNotFound", hashKind: kind, ref },
          } satisfies SkillsShUpdateMember;
        }
        const localBytes = yield* inspectSkillsShCompatibleHash(
          join(root, folder),
          join(root, folder),
        );
        if (Result.isFailure(localBytes)) {
          return {
            ...base,
            upstream_tree: tipState.tree,
            status: "unverifiable",
            reason: { _tag: "OriginalBytesUnavailable", failures: localBytes.failure },
          } satisfies SkillsShUpdateMember;
        }
        const local = localBytes.success;
        if (local === claimed && tipState.hash === claimed) {
          return {
            ...base,
            upstream_tree: tipState.tree,
            baseline_commit: tip,
            baseline_tree: tipState.tree,
            baseline_verification: "lock+original-bytes",
            status: "current",
          } satisfies SkillsShUpdateMember;
        }
        if (local !== claimed) {
          return {
            ...base,
            upstream_tree: tipState.tree,
            status: tipState.hash === local ? "lock-stale" : "differs-from-lock-and-upstream",
          } satisfies SkillsShUpdateMember;
        }
        const baseline = yield* member.baseline;
        return {
          ...base,
          upstream_tree: tipState.tree,
          ...(baseline ? { baseline_commit: baseline.commit, baseline_tree: baseline.tree } : {}),
          ...(baseline ? { baseline_verification: "lock+original-bytes" as const } : {}),
          status: baseline ? "update-available" : "unverifiable",
          ...(baseline
            ? {}
            : { reason: { _tag: "BaselineNotFound" as const, hashKind: kind, ref } }),
        } satisfies SkillsShUpdateMember;
      }),
    );
    members.push(
      Result.isSuccess(checked)
        ? checked.success
        : {
            ...base,
            status: "unverifiable",
            reason: { _tag: "GitEvidenceUnavailable", failure: checked.failure },
          },
    );
  }
  return { checked_at: checkedAt, members };
});
