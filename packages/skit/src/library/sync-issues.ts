import { Schema } from "effect";
import { StepError } from "./store/operation-failures.js";
import { Enabled } from "./library-contracts.js";
import { Duplicate } from "./installed-skill-facts.js";
import { InstalledSkillConflict } from "../installed-skills/conflict.js";
import { SyncConflictDetail } from "./internal/sync/conflict.js";

/** Nonfatal device installation issues after the portable Library has synced. */
export const SyncEnablementIssue = Schema.TaggedUnion({
  SelectionMissing: { selection: Enabled },
  DuplicateScanFailed: {
    // A saved failure may itself name a stopped operation; defer the storage schema edge.
    failure: Schema.suspend((): Schema.Codec<StepError, unknown> => StepError),
  },
  ExistingCopy: { copy: Duplicate },
  InstallationFailed: {
    failure: Schema.suspend((): Schema.Codec<StepError, unknown> => StepError),
  },
  InstalledFolderConflicted: {
    path: Schema.String,
    conflicts: Schema.Array(InstalledSkillConflict),
  },
});
export type SyncEnablementIssue = typeof SyncEnablementIssue.Type;

export const SyncIssue = Schema.Union([SyncConflictDetail, SyncEnablementIssue]);
export type SyncIssue = typeof SyncIssue.Type;
