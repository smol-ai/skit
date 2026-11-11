import { Schema } from "effect";
import { Duplicate } from "./installed-skill-facts.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────
/** What prevents a reviewed plan from applying safely. Frontends write the words. */
export const StalePlanReason = Schema.TaggedUnion({
  SnapshotRequired: {},
  SnapshotChanged: {},
  LibraryChanged: {},
  ReviewedStateChanged: {},
  PlanChanged: { kind: Schema.Literals(["apply", "destinations"]) },
  PlanInvalid: { kind: Schema.Literals(["intent", "acceptance", "manage"]) },
  OperationMissing: { kind: Schema.Literals(["undo", "install", "sync-publication"]) },
  OperationAlreadyRecorded: {},
  EvidenceChanged: {
    kind: Schema.Literals([
      "undo",
      "undo-staging",
      "undo-successor",
      "recovery",
      "recovery-entry",
      "manage",
      "installed",
      "inventory-backup",
    ]),
    path: Schema.optionalKey(Schema.String),
  },
  ContentChanged: {
    kind: Schema.Literals(["skill", "edit", "reviewed", "undo-source"]),
    path: Schema.optionalKey(Schema.String),
    skillName: Schema.optionalKey(Schema.String),
  },
  MissingRecord: {
    record: Schema.Literals([
      "undo-source",
      "installed-row",
      "installed-folder",
      "selected-version",
      "edited-copy",
    ]),
    at: Schema.optionalKey(Schema.String),
  },
  DestinationOccupied: {
    kind: Schema.Literals(["undo-source", "undo-destination"]),
    path: Schema.String,
  },
  SessionNotOpen: { action: Schema.Literals(["propose", "confirm"]) },
  SyncChanged: { part: Schema.Literals(["manifest", "base", "target"]) },
  SyncPlanInvalid: {
    reason: Schema.Literals([
      "library-mismatch",
      "receipt-missing",
      "receipt-mismatch",
      "unexpected-receipt",
    ]),
  },
  InstalledBytesChanged: {
    kind: Schema.Literals(["reviewed", "recorded", "installed"]),
    path: Schema.String,
  },
}).annotate({ identifier: "StalePlanReason" });
export type StalePlanReason = typeof StalePlanReason.Type;

/** The Library moved on since the change was planned; a revision check names both revisions. */
export class StalePlan
  extends Schema.TaggedError<StalePlan, { readonly brand: unique symbol }>()("Library.StalePlan", {
    reason: StalePlanReason,
    expected: Schema.optionalKey(Schema.String.pipe(Schema.brand("Revision"))),
    actual: Schema.optionalKey(Schema.String.pipe(Schema.brand("Revision"))),
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT";
}

/** Enabling would replace the user's own link where SKIT writes the copy; keeping both is impossible. */
export class InstalledSkillWouldReplaceLink
  extends Schema.TaggedError<InstalledSkillWouldReplaceLink, { readonly brand: unique symbol }>()(
    "InstalledSkillWouldReplaceLink",
    {
      links: Schema.Array(Schema.String),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT";
}

/** Policy: Library refuses a duplicate; InstalledSkills only reports that it is there. */
export class InstalledSkillWouldDuplicate
  extends Schema.TaggedError<InstalledSkillWouldDuplicate, { readonly brand: unique symbol }>()(
    "InstalledSkillWouldDuplicate",
    {
      duplicates: Schema.Array(Duplicate),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT";
}

export class DestinationsIncomplete
  extends Schema.TaggedError<DestinationsIncomplete, { readonly brand: unique symbol }>()(
    "Library.DestinationsIncomplete",
    {
      paths: Schema.Array(Schema.String),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT";
}
