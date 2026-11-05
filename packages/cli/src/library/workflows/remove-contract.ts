import { Schema } from "effect";

export const RemovePlan = Schema.Struct({
  subject_id: Schema.String,
  subject_kind: Schema.Literals(["collection", "skill"]),
  versions: Schema.Number,
  skills: Schema.Number,
  global_enabled: Schema.Number,
  repositories: Schema.Number,
  installed_skills: Schema.Number,
});
export type RemovePlan = typeof RemovePlan.Type;

export const RemoveResult = Schema.Struct({
  ...RemovePlan.fields,
  uninstalled: Schema.Number,
});
export type RemoveResult = typeof RemoveResult.Type;
