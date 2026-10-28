import { Hash, SourceDiscoveryDiagnostic } from "@smolai/skit-core";
import { Schema } from "effect";

/** What a refresh means for the Skills this device enables. */
const SkillChanges = {
  diagnostics: Schema.optionalKey(Schema.Array(SourceDiscoveryDiagnostic)),
  label: Schema.String,
  /** New upstream Skills enabled because the Collection is followed. */
  enabled: Schema.Array(Schema.String),
  /** New upstream Skills nothing enables. */
  new_available: Schema.Number,
  /** Enabled Skills whose bytes changed. */
  updated: Schema.Array(Schema.String),
  /** Skills deleted upstream and retired because their Collection is followed. */
  removed: Schema.Array(Schema.String),
  /** Individually enabled Skills deleted upstream, kept at their last Version. */
  kept: Schema.Array(Schema.String),
};

export const UpdateFailure = Schema.Struct({
  status: Schema.tag("failed"),
  subject_id: Schema.String,
  subject_kind: Schema.Literals(["collection", "skill"]),
  label: Schema.String,
  source: Schema.String,
  phase: Schema.Literals(["source", "install"]),
  source_imported: Schema.Boolean,
  error: Schema.Struct({
    code: Schema.String,
    exitCode: Schema.Number,
    message: Schema.String,
    remediation: Schema.String,
  }),
});
export type UpdateFailure = typeof UpdateFailure.Type;

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
      installed: Schema.Number,
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
    available_snapshot_digest: Hash,
    changed: Schema.Boolean,
    ...SkillChanges,
  }),
);
export type UpdatePlan = typeof UpdatePlan.Type;
