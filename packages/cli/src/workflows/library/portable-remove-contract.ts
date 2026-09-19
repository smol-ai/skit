import { Schema } from "effect";

export const PortableRemovePlan = Schema.Struct({
  subject_id: Schema.String,
  subject_kind: Schema.Literals(["collection", "skill"]),
  versions: Schema.Number,
  skills: Schema.Number,
  global_bindings: Schema.Number,
  repository_bindings: Schema.Number,
  owned_projections: Schema.Number,
});
export type PortableRemovePlan = typeof PortableRemovePlan.Type;

export const PortableRemoveResult = Schema.Struct({
  ...PortableRemovePlan.fields,
  retired: Schema.Number,
});
export type PortableRemoveResult = typeof PortableRemoveResult.Type;
