import { Schema } from "effect";
import type { HarnessShadow } from "../../projection/harness-shadows.js";
import type {
  SetupResult,
  SetupSkillInstance,
  SetupOnboardingCandidate,
} from "./setup-contract.js";

import { isSetupCandidateFromCodex, setupInstanceGroupKey } from "./setup-onboarding.js";

export const SetupDuplicateAction = Schema.Literals(["retain-only", "retire-aliases", "keep-both"]);
export type SetupDuplicateAction = typeof SetupDuplicateAction.Type;

/** Evidence authorizing these individual links, independently of later setup stages. */
export const SetupApprovedAlias = Schema.Struct({
  path: Schema.String,
  canonicalPath: Schema.String,
  linkTarget: Schema.String,
  dev: Schema.Number,
  ino: Schema.Number,
});
export interface SetupApprovedAlias extends Schema.Schema.Type<typeof SetupApprovedAlias> {}

/** Every relevant alias must be an individual link to the selected canonical source. */
export function retirableShadowAliases(sourcePath: string, shadows: readonly HarnessShadow[]) {
  if (
    !shadows.length ||
    shadows.some(
      (shadow) =>
        shadow.canonicalPath !== sourcePath ||
        shadow.aliases.some((alias) => alias.via !== "symlink" || alias.linkPath !== alias.path),
    )
  )
    return [];
  return [
    ...new Set(shadows.flatMap((shadow) => shadow.aliases.map((alias) => alias.path))),
  ].sort();
}

export type SetupCopyConflict =
  | { readonly kind: "none" }
  | {
      readonly kind: "retirable" | "preserve-copies";
      readonly shadows: readonly HarnessShadow[];
      readonly aliases: readonly string[];
    };

/** Eligible global copies have harness readers and no repository custody. */
export const isSetupProjectionTarget = (
  instance: SetupSkillInstance | undefined,
): instance is SetupSkillInstance & { readonly scope: "global" } =>
  instance?.scope === "global" && !instance.git.repository && instance.harnesses.length > 0;

/** Shared applicability and allowed actions for prompting and both mutation validators. */
export function copyConflict(
  observed: SetupResult,
  selection: { readonly name: string; readonly sourcePath: string },
): SetupCopyConflict {
  const candidate = observed.onboarding.candidates.find(
    (item) => item.name === selection.name && item.paths.includes(selection.sourcePath),
  );
  const instance = observed.instances.find((item) => item.path === selection.sourcePath);
  const shadows = candidate?.shadows ?? [];
  if (
    !shadows.length ||
    !isSetupProjectionTarget(instance) ||
    candidate?.action === "repository-owned"
  )
    return { kind: "none" };
  const aliases = retirableShadowAliases(selection.sourcePath, shadows);
  return { kind: aliases.length ? "retirable" : "preserve-copies", shadows, aliases };
}

export const SetupCopySelection = Schema.Struct({
  name: Schema.String,
  sourcePath: Schema.String,
  duplicateAction: Schema.optionalKey(SetupDuplicateAction),
  approvedAliases: Schema.optionalKey(Schema.Array(SetupApprovedAlias)),
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
    | { readonly duplicateAction?: never; readonly approvedAliases?: never }
    | { readonly duplicateAction: "retain-only" | "keep-both"; readonly approvedAliases?: never }
    | {
        readonly duplicateAction: "retire-aliases";
        readonly approvedAliases: readonly SetupApprovedAlias[];
      }
  );

export function setupSelectedCopies(
  observed: SetupResult,
  add: readonly { readonly name: string; readonly sourcePath: string }[],
  bind: readonly { readonly name: string; readonly sourcePath: string }[],
): SetupSelectedCopy[] {
  return [
    ...add.map((selection) => ({ ...selection, operation: "add" as const })),
    ...bind.map((selection) => ({ ...selection, operation: "bind" as const })),
  ].map((copy) => ({ ...copy, conflict: copyConflict(observed, copy) }));
}

/** Choices the review can interpret; presentation supplies labels and ordering. */
export const setupReviewCopies = (
  instances: readonly SetupSkillInstance[],
  candidates: readonly SetupOnboardingCandidate[],
) =>
  instances
    .filter(
      (instance) => instance.owner.kind !== "skit" || instance.owner.membership.kind !== "retained",
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
  /** Group keys of every installed skills.sh Collection setup can import. */
  readonly sources: readonly string[];
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
  const sources = [
    ...new Set(
      candidates.flatMap((candidate) =>
        candidate.action === "import-observed-collection" ? [candidate.groupKey] : [],
      ),
    ),
  ].sort();
  const chosenGroups = new Set<string>();
  const copies: { name: string; sourcePath: string }[] = [];
  const reviewable = setupReviewCopies(instances, candidates).sort((left, right) =>
    left.instance.path.localeCompare(right.instance.path),
  );
  for (const { instance, selectable, siblings, groupKey } of reviewable) {
    const differs = siblings.some(
      (sibling) =>
        instance.contentIdentity.observedHash === undefined ||
        sibling.contentIdentity.observedHash !== instance.contentIdentity.observedHash,
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
