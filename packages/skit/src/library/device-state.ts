// Device-local Library records: where skills are enabled and what is installed. Kept apart from
// library-state.ts so a setup's operation record (store/state-schema.ts) can record them.

import { Schema } from "effect";
import { isAbsolute } from "node:path";
import { InstalledSkillId, SkillId, SkillVersionId } from "./entity-ids.js";
import { Enabled } from "./library-contracts.js";
import { Hash, InstallDestination, InvocationPolicy } from "../vocabulary.js";

export const AbsoluteDevicePath = Schema.String.check(
  Schema.makeFilter(isAbsolute, { message: "Expected an absolute device path" }),
);
export type AbsoluteDevicePath = typeof AbsoluteDevicePath.Type;

/** How agents may invoke each enabled skill, when the user overrode what its author declared. */
export const InvocationPolicies = Schema.Record(SkillId, InvocationPolicy);
export type InvocationPolicies = typeof InvocationPolicies.Type;

/** What is enabled in one repository folder. It stays on this device; sync never sends it. */
export const Repository = Schema.Struct({
  root: AbsoluteDevicePath,
  enabled: Schema.Array(Enabled),
  invocation_policies: Schema.optionalKey(InvocationPolicies),
});
export interface Repository extends Schema.Schema.Type<typeof Repository> {}

/** What every installed copy records, whatever its status. */
const InstalledSkillFields = {
  installed_skill_id: InstalledSkillId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  destination: InstallDestination,
  root: AbsoluteDevicePath,
  path: AbsoluteDevicePath,
  /** The hash of the folder SKIT wrote. */
  expected_hash: Hash,
  installed_at: Schema.String,
} as const;

/** On disk exactly as SKIT wrote it. */
export const InstalledSkillInstalled = Schema.Struct({
  ...InstalledSkillFields,
  status: Schema.Literal("installed"),
});
export interface InstalledSkillInstalled extends Schema.Schema.Type<
  typeof InstalledSkillInstalled
> {}

/** Recorded, but not on disk as SKIT wrote it: not written yet, or moved to recovery. */
export const InstalledSkillPending = Schema.Struct({
  ...InstalledSkillFields,
  status: Schema.Literal("pending"),
});
export interface InstalledSkillPending extends Schema.Schema.Type<typeof InstalledSkillPending> {}

/** The folder holds something other than what SKIT wrote: the user's edit, or a folder SKIT does not own. */
export const InstalledSkillConflicted = Schema.Struct({
  ...InstalledSkillFields,
  status: Schema.Literal("conflicted"),
  current_hash: Hash,
});
export interface InstalledSkillConflicted extends Schema.Schema.Type<
  typeof InstalledSkillConflicted
> {}

/** The user deleted the folder; SKIT does not put it back unless asked to restore it. */
export const InstalledSkillSuppressed = Schema.Struct({
  ...InstalledSkillFields,
  status: Schema.Literal("suppressed"),
  suppression_reason: Schema.Literal("native_delete"),
  suppressed_at: Schema.optionalKey(Schema.String),
});
export interface InstalledSkillSuppressed extends Schema.Schema.Type<
  typeof InstalledSkillSuppressed
> {}

export const InstalledSkill = Schema.Union([
  InstalledSkillInstalled,
  InstalledSkillPending,
  InstalledSkillConflicted,
  InstalledSkillSuppressed,
]);
export type InstalledSkill =
  | InstalledSkillInstalled
  | InstalledSkillPending
  | InstalledSkillConflicted
  | InstalledSkillSuppressed;

/** What the account enables travels with sync; a device may instead choose what it installs. */
export const DeviceSkillSelection = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("follow-account") }),
  Schema.Struct({
    mode: Schema.Literal("choose"),
    enabled: Schema.Array(Enabled),
    invocation_policies: Schema.optionalKey(InvocationPolicies),
  }),
]);
export type DeviceSkillSelection = typeof DeviceSkillSelection.Type;
