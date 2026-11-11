import type * as Library from "@smolai/skit-core/library";
import { CommandError } from "../../commands/error-output.js";
import { commandError } from "../../commands/failure-classification.js";
import { AuthoredSkillIssue } from "@smolai/skit-core/library/update";
import { EditImportPlan, EditImportResult } from "@smolai/skit-core/library/edit";
import { Hash } from "@smolai/skit-core/shared";
import { SourceDiscoveryDiagnostic } from "@smolai/skit-core/library/source";
import { Effect, Schema } from "effect";

/** What a refresh means for the Skills this device enables. */
const SkillChanges = {
  diagnostics: Schema.optionalKey(Schema.Array(SourceDiscoveryDiagnostic)),
  label: Schema.String,
  /** New upstream Skills enabled because the Collection is followed. */
  enabled: Schema.Array(Schema.String),
  /** New upstream Skills nothing enables. */
  new_available: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Enabled Skills whose bytes changed. */
  updated: Schema.Array(Schema.String),
  /** Skills deleted upstream and retired because their Collection is followed. */
  removed: Schema.Array(Schema.String),
  /** Individually enabled Skills deleted upstream, kept at their last Version. */
  kept: Schema.Array(Schema.String),
};

const UpdateFailure = Schema.Struct({
  status: Schema.tag("failed"),
  subject_id: Schema.String,
  subject_kind: Schema.Literals(["collection", "skill"]),
  label: Schema.String,
  source: Schema.String,
  phase: Schema.Literals(["source", "install"]),
  source_imported: Schema.Boolean,
  error: CommandError,
});

export const UpdateResult = Schema.Array(
  Schema.Union([
    UpdateFailure,
    Schema.Struct({
      subject_id: Schema.String,
      subject_kind: Schema.Literals(["collection", "skill"]),
      previous_collection_version_id: Schema.String,
      selected_collection_version_id: Schema.String,
      snapshot_digest: Hash,
      changed: Schema.Boolean,
      installed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      issues: Schema.optionalKey(Schema.Array(AuthoredSkillIssue)),
      sync_status: Schema.optionalKey(Schema.String),
      sync_error: Schema.optionalKey(UpdateFailure.fields.error),
      installation_error: Schema.optionalKey(UpdateFailure.fields.error),
      ...SkillChanges,
    }),
  ]),
);
export type UpdateResult = typeof UpdateResult.Type;

export const UpdatePlan = Schema.Array(
  Schema.Struct({
    subject_id: Schema.String,
    subject_kind: Schema.Literals(["collection", "skill"]),
    current_snapshot_digest: Hash,
    // Authored previews do not invent the identity of a future saved revision/composition.
    available_snapshot_digest: Schema.optionalKey(Hash),
    issues: Schema.optionalKey(Schema.Array(AuthoredSkillIssue)),
    changed: Schema.Boolean,
    ...SkillChanges,
  }),
);
export type UpdatePlan = typeof UpdatePlan.Type;

export const updateOutputContracts = {
  update: { id: "skit.update.v9", schema: UpdateResult },
  updatePlan: { id: "skit.update.plan.v7", schema: UpdatePlan },
  // Preserve the released wire-name families; internal names describe installed edits.
  installedEdit: { id: "skit.update.projection-retention.v3", schema: EditImportResult },
  installedEditPlan: {
    id: "skit.update.projection-retention.plan.v3",
    schema: EditImportPlan,
  },
} as const;

/** Project the owner's native failure causes at the CLI result boundary. */
export const sourceUpdateOutput = (
  outcomes: Effect.Success<ReturnType<Library.Interface["update"]>>,
): UpdateResult =>
  outcomes.map((item) => {
    if ("status" in item) return { ...item, error: commandError(item.error) };
    const { sync_error, installation_error, ...rest } = item;
    return {
      ...rest,
      ...(installation_error === undefined
        ? {}
        : { installation_error: commandError(installation_error) }),
      ...(sync_error === undefined ? {} : { sync_error: commandError(sync_error) }),
    };
  });
