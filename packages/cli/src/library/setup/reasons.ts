import type {
  SetupLeftAloneReason,
  SetupOnboardingCandidate,
} from "@smolai/skit-core/library/setup";

/** Setup reports why a skill was left alone; the frontend owns the explanation. */
const explanations = {
  "import-observed-collection": "Not selected to import from its recorded source",
  "bind-existing-entry": "Not selected to reconnect to its Library skill",
  "manage-locally": "Not selected to add to the Library and manage",
  "harness-owned": "Managed by its harness; left in place",
  "repository-owned": "Kept in its repository",
  "leave-alone": "No setup change selected",
  "invalid-ownership-marker": "The SKIT ownership marker is invalid",
  "content-unhashable": "The installed files could not be checked",
  "ambiguous-library-match": "More than one Library skill matches these contents",
  "library-skill-name-mismatch": "The matching Library skill has a different name",
  "divergent-copies": "Copies of this skill have different contents",
  "contested-lock-claim": "The installation records disagree about this skill's source",
} satisfies Record<SetupLeftAloneReason, string>;

export const setupLeftAloneReason = (reason: SetupLeftAloneReason): string => explanations[reason];

const actionNames = {
  "import-observed-collection": "Import from recorded sources",
  "bind-existing-entry": "Reconnect to Library skills",
  "manage-locally": "Add to the Library and manage",
  "harness-owned": "Managed by a harness",
  "repository-owned": "Kept in repositories",
  blocked: "Needs attention",
  "leave-alone": "Leave in place",
} satisfies Record<SetupOnboardingCandidate["action"], string>;
export const setupActionName = (action: SetupOnboardingCandidate["action"]): string =>
  actionNames[action];
