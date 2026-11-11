import { Schema } from "effect";
import { CollectionSource } from "@smolai/skit-core/library/queries";

export const RemovePlan = Schema.Struct({
  subject_id: Schema.String,
  subject_kind: Schema.Literals(["collection", "skill"]),
  collection_label: Schema.optionalKey(Schema.String),
  collection_source: Schema.optionalKey(CollectionSource),
  versions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skills: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  global_enabled: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  repositories: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  installed_skills: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type RemovePlan = typeof RemovePlan.Type;

export const RemoveResult = Schema.Struct({
  ...RemovePlan.fields,
  uninstalled: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type RemoveResult = typeof RemoveResult.Type;

export const removeOutputContracts = {
  remove: { id: "skit.remove.v5", schema: RemoveResult },
  removePlan: { id: "skit.remove.plan.v5", schema: RemovePlan },
} as const;
