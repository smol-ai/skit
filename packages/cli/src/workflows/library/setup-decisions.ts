import { Schema } from "effect";
import { Digest, hashParts } from "@smolai/skit-core";
import type { DuplicateCopy } from "../../install/duplicates.js";
import type {
  SetupResult,
  SetupSkillInstance,
  SetupOnboardingCandidate,
} from "./setup-contract.js";

import { isSetupCandidateFromCodex, setupInstanceGroupKey } from "./setup-onboarding.js";

export const SetupDuplicateAction = Schema.Literals([
  "retain-only",
  "retire-aliases",
  "keep-both",
  "preserve-duplicates",
]);
export type SetupDuplicateAction = typeof SetupDuplicateAction.Type;

/** Evidence authorizing these individual links, independently of later setup stages. */
export const ApprovedSymlink = Schema.Struct({
  path: Schema.String,
  canonicalPath: Schema.String,
  linkTarget: Schema.String,
  dev: Schema.Number,
  ino: Schema.Number,
});
export interface ApprovedSymlink extends Schema.Schema.Type<typeof ApprovedSymlink> {}

export const SetupApprovedCopy = Schema.Struct({
  path: Schema.String,
  currentHash: Digest,
  dev: Schema.Number,
  ino: Schema.Number,
});
export interface SetupApprovedCopy extends Schema.Schema.Type<typeof SetupApprovedCopy> {}

/** Every relevant alias must be an individual link to the selected canonical source. */
export function duplicateSymlinksToBackUp(
  sourcePath: string,
  duplicates: readonly DuplicateCopy[],
) {
  if (
    !duplicates.length ||
    duplicates.some(
      (duplicate) =>
        duplicate.canonicalPath !== sourcePath ||
        duplicate.aliases.some((alias) => alias.via !== "symlink" || alias.linkPath !== alias.path),
    )
  )
    return [];
  return [
    ...new Set(duplicates.flatMap((duplicate) => duplicate.aliases.map((alias) => alias.path))),
  ].sort();
}

export type SetupCopyConflict =
  | { readonly kind: "none" }
  | {
      readonly kind: "retirable" | "preservable" | "preserve-copies";
      readonly duplicates: readonly DuplicateCopy[];
      readonly aliases: readonly string[];
      /**
       * A link sits where SKIT writes this skill's copy. Enabling replaces it, so the copies cannot
       * be kept side by side: `keep-both` is not a choice.
       */
      readonly replacesLink: boolean;
    };

/** Eligible global copies have harness readers and no repository ownership. */
export const isSetupInstallDestination = (
  instance: SetupSkillInstance | undefined,
): instance is SetupSkillInstance & { readonly scope: "global" } =>
  instance?.scope === "global" && !instance.git.repository && instance.harnesses.length > 0;

/** Shared applicability and allowed actions for prompting and both mutation validators. */
export function copyConflict(
  scan: Pick<SetupResult, "instances"> & {
    readonly onboarding: Pick<SetupResult["onboarding"], "candidates">;
  },
  selection: { readonly name: string; readonly sourcePath: string },
): SetupCopyConflict {
  const candidate = scan.onboarding.candidates.find(
    (item) => item.name === selection.name && item.paths.includes(selection.sourcePath),
  );
  const instance = scan.instances.find((item) => item.path === selection.sourcePath);
  const duplicates = candidate?.duplicates ?? [];
  if (
    !duplicates.length ||
    !isSetupInstallDestination(instance) ||
    candidate?.action === "repository-owned"
  )
    return { kind: "none" };
  const aliases = duplicateSymlinksToBackUp(selection.sourcePath, duplicates);
  const selectedHash = instance?.contentIdentity.currentHash;
  const preservable =
    selectedHash !== undefined &&
    duplicates.every((duplicate) =>
      duplicate.aliases.every((alias) => {
        const copy = scan.instances.find((item) => item.path === alias.path);
        return (
          alias.via === "directory" &&
          alias.path === duplicate.canonicalPath &&
          copy !== undefined &&
          isSetupInstallDestination(copy) &&
          !copy.git.repository &&
          (copy.owner.kind === "unknown" || copy.owner.kind === "skills-sh") &&
          copy.contentIdentity.currentHash === selectedHash
        );
      }),
    );
  return {
    kind: aliases.length ? "retirable" : preservable ? "preservable" : "preserve-copies",
    duplicates,
    aliases,
    replacesLink: (candidate?.destinationLinks?.length ?? 0) > 0,
  };
}

/** Stable public source choice identity; internal lock keys contain NUL separators. */
export const setupSourceChoiceId = (key: string) => hashParts([key]);

/** Alternatives valid for every selected copy. An absent conflict needs no duplicate decision. */
export function setupDuplicateActions(
  copies: readonly SetupSelectedCopy[],
): SetupDuplicateAction[] {
  const conflicts = copies.filter((copy) => copy.conflict.kind !== "none");
  if (!copies.some(setupDuplicateChoiceRequired)) return [];
  return SetupDuplicateAction.literals.filter(
    (action) =>
      action === "retain-only" ||
      (action === "retire-aliases" &&
        conflicts.every((copy) => copy.conflict.kind === "retirable")) ||
      (action === "keep-both" &&
        conflicts.every((copy) => copy.conflict.kind !== "none" && !copy.conflict.replacesLink)),
  );
}

/** Verified individual aliases are housekeeping after enablement has been selected. */
export const setupDuplicateChoiceRequired = (copy: Pick<SetupSelectedCopy, "conflict">) =>
  copy.conflict.kind === "preserve-copies";

export interface SetupExplicitSelection {
  readonly reconcileSkillIds?: readonly string[];
  readonly useRetainedSkillIds?: readonly string[];
  readonly useCopyPaths?: readonly string[];
  readonly sourceIds: readonly string[];
  readonly copyPaths: readonly string[];
  readonly removePaths: readonly string[];
}

export const SetupCopySelection = Schema.Struct({
  name: Schema.String,
  sourcePath: Schema.String,
  duplicateAction: Schema.optionalKey(SetupDuplicateAction),
  approvedSymlinks: Schema.optionalKey(Schema.Array(ApprovedSymlink)),
  approvedCopies: Schema.optionalKey(Schema.Array(SetupApprovedCopy)),
});
export interface SetupCopySelection extends Schema.Schema.Type<typeof SetupCopySelection> {}

export interface SetupSelectedCopy {
  readonly operation: "add" | "bind";
  readonly name: string;
  readonly sourcePath: string;
  readonly conflict: SetupCopyConflict;
}

export type SetupCopyDecision = SetupSelectedCopy &
  (
    | {
        readonly duplicateAction?: never;
        readonly approvedSymlinks?: never;
        readonly approvedCopies?: never;
      }
    | {
        readonly duplicateAction: "retain-only" | "keep-both";
        readonly approvedSymlinks?: never;
        readonly approvedCopies?: never;
      }
    | {
        readonly duplicateAction: "retire-aliases";
        readonly approvedSymlinks: readonly ApprovedSymlink[];
        readonly approvedCopies?: never;
      }
    | {
        readonly duplicateAction: "preserve-duplicates";
        readonly approvedCopies: readonly SetupApprovedCopy[];
        readonly approvedSymlinks?: never;
      }
  );

/** Front ends submit intent; the application captures and validates filesystem evidence. */
export type SetupCopyChoice = SetupSelectedCopy & {
  readonly duplicateAction?: SetupDuplicateAction;
  readonly approvedSymlinks?: readonly ApprovedSymlink[];
  readonly approvedCopies?: readonly SetupApprovedCopy[];
};

export function setupSelectedCopies(
  scan: SetupResult,
  add: readonly { readonly name: string; readonly sourcePath: string }[],
  bind: readonly { readonly name: string; readonly sourcePath: string }[],
): SetupSelectedCopy[] {
  return [
    ...add.map((selection) => ({ ...selection, operation: "add" as const })),
    ...bind.map((selection) => ({ ...selection, operation: "bind" as const })),
  ].map((copy) => ({ ...copy, conflict: copyConflict(scan, copy) }));
}

/** Choices the review can interpret; presentation supplies labels and ordering. */
export const setupReviewCopies = (
  instances: readonly SetupSkillInstance[],
  candidates: readonly SetupOnboardingCandidate[],
) =>
  instances
    .filter(
      (instance) =>
        instance.owner.kind !== "skit" || instance.owner.membership.kind !== "in-library",
    )
    .filter(
      (instance) =>
        !candidates.some(
          (candidate) =>
            candidate.action === "import-observed-collection" &&
            candidate.paths.includes(instance.path),
        ),
    )
    .map((instance) => {
      const candidate = candidates.find((item) => item.paths.includes(instance.path));
      const groupKey = setupInstanceGroupKey(instance);
      return {
        instance,
        candidate,
        groupKey,
        siblings: instances.filter(
          (item) => setupInstanceGroupKey(item) === groupKey && item.path !== instance.path,
        ),
        value: instances.some((item) => item.name === instance.name && item.path !== instance.path)
          ? `${instance.name}\0${instance.path}`
          : instance.name,
        selectable:
          candidate !== undefined &&
          instance.owner.kind !== "skit" &&
          instance.owner.kind !== "authored" &&
          instance.owner.kind !== "pnpm" &&
          !(candidate.action === "blocked" && candidate.reason !== "divergent-copies"),
      };
    });
export type SetupReviewCopy = ReturnType<typeof setupReviewCopies>[number];

export interface SetupRecommendation {
  /** Every installed skills.sh Collection setup can import, with the skills it brings. */
  readonly sources: readonly {
    readonly groupKey: string;
    readonly source: string;
    readonly names: readonly string[];
  }[];
  /** One copy per skill: user-owned, global, unambiguous, and outside Codex's own skills. */
  readonly copies: readonly { readonly name: string; readonly sourcePath: string }[];
}

/**
 * What setup recommends from one observation: the selection guided setup starts from and the one
 * `skit setup --apply` takes. It is a function of the observation alone, so the plan ID that
 * covers the observation also covers the recommendation. Copies whose content differs from a
 * sibling are never recommended; choosing between them needs a person.
 */
export function recommendedSetupSelection(
  instances: readonly SetupSkillInstance[],
  candidates: readonly SetupOnboardingCandidate[],
  home: string,
): SetupRecommendation {
  const imports = new Map<string, { groupKey: string; source: string; names: string[] }>();
  for (const candidate of candidates) {
    if (candidate.action !== "import-observed-collection") continue;
    const entry = imports.get(candidate.groupKey) ?? {
      groupKey: candidate.groupKey,
      source: candidate.source,
      names: [],
    };
    entry.names.push(candidate.name);
    imports.set(candidate.groupKey, entry);
  }
  const sources = [...imports.values()]
    .map((entry) => ({ ...entry, names: entry.names.sort() }))
    .sort((left, right) => left.groupKey.localeCompare(right.groupKey));
  const chosenGroups = new Set<string>();
  const copies: { name: string; sourcePath: string }[] = [];
  const reviewable = setupReviewCopies(instances, candidates).sort((left, right) =>
    left.instance.path.localeCompare(right.instance.path),
  );
  for (const { instance, selectable, siblings, groupKey } of reviewable) {
    const differs = siblings.some(
      (sibling) =>
        instance.contentIdentity.currentHash === undefined ||
        sibling.contentIdentity.currentHash !== instance.contentIdentity.currentHash,
    );
    if (
      !selectable ||
      differs ||
      chosenGroups.has(groupKey) ||
      instance.owner.kind !== "unknown" ||
      instance.git.repository !== undefined ||
      isSetupCandidateFromCodex([instance.path, ...instance.aliases], home)
    )
      continue;
    chosenGroups.add(groupKey);
    copies.push({ name: instance.name, sourcePath: instance.path });
  }
  return { sources, copies };
}

/**
 * The exact command that applies a recommended plan, for a person or agent to copy. Paths are the
 * resolved absolute roots, never `~`: agent harnesses match commands against allow rules only when
 * every word is literal, and Codex treats a word containing `~` or `$` as possibly expanded.
 */
export function setupApplyCommandLine(input: {
  readonly planId: string;
  readonly repositoryRoots: readonly string[];
  readonly needsDuplicateDecision: boolean;
}): string {
  const quote = (word: string) =>
    /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
  return [
    "skit setup --apply",
    input.planId,
    ...input.repositoryRoots.flatMap((root) => ["--work-dir", quote(root)]),
    ...(input.needsDuplicateDecision
      ? ["--duplicates", "<retain-only|keep-both|retire-aliases>"]
      : []),
  ].join(" ");
}
