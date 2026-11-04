import { Schema } from "effect";
import { SkillId, CollectionId } from "./entity-ids.js";
import { Invocation, InvocationPolicies } from "./device-state.js";
import { Enabled as EnabledItem } from "./library-contracts.js";
import { Duplicate, Warning } from "./installed-skill-facts.js";
import { InstallScope, InstallDestination } from "../vocabulary.js";

/** One enabled change at one scope, with what a review of it shows. */
export const EnabledChange = Schema.Struct({
  _tag: Schema.Literals(["Enable", "Disable"]),
  subject_id: Schema.Union([SkillId, CollectionId]),
  skills: Schema.Array(Schema.String),
  scope: InstallScope,
  action: Schema.Literals(["enable", "disable"]),
  invocation: Schema.optionalKey(Invocation),
  changed: Schema.Boolean,
  enabled: Schema.Array(EnabledItem),
  invocation_policies: Schema.optionalKey(InvocationPolicies),
  repair: Schema.optionalKey(Schema.Boolean),
  duplicates: Schema.optionalKey(Schema.Array(Duplicate)),
  warnings: Schema.optionalKey(Schema.Array(Warning)),
  unmanaged_destinations: Schema.optionalKey(
    Schema.Array(Schema.Struct({ destination: InstallDestination, path: Schema.String })),
  ),
});
export type EnabledChange = typeof EnabledChange.Type;
