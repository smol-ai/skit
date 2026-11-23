import { Schema } from "effect";
import { HarnessName } from "../../harnesses/contracts.js";
import { Hash } from "../../shared/hash.js";
import { OwnershipIssue } from "../../installed-skills/metadata.js";
import { SkillAssessmentAcceptance } from "../assessment-acceptance.js";
import {
  Collection,
  Skill,
  CollectionVersion,
  Import,
  LibraryManifest,
  Enabled,
} from "../library-contracts.js";
import {
  DeviceSkillSelection,
  InstalledSkill,
  InvocationPolicies,
  Repository,
} from "../device-state.js";
// Decoded state is readonly except where the transaction API revises a candidate in place.
// Each Schema.mutableKey below marks one such field; every other field stays readonly, so
// the schema records exactly which parts of a snapshot the reconciler is allowed to touch.
// Schema.optional retains existing candidate undefined values; JSON omits those keys.
export const InventoryScanIssue = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    harness: HarnessName,
    code: Schema.Literal("MISSING_ROOT"),
  }),
  Schema.Struct({
    path: Schema.String,
    harness: HarnessName,
    code: Schema.Literal("UNREADABLE_PATH"),
  }),
  Schema.Struct({
    path: Schema.String,
    target: Schema.String,
    harness: HarnessName,
    code: Schema.Literal("DANGLING_SYMLINK"),
  }),
]);
export type InventoryScanIssue = typeof InventoryScanIssue.Type;
const LibraryDeviceStateFields = {
  unmanaged: Schema.mutableKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          harness: HarnessName,
          /** All Harnesses that observed this one physical path during the latest pass. */
          harnesses: Schema.optional(Schema.mutable(Schema.Array(HarnessName))),
          path: Schema.String,
          paths: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
          currentHash: Hash,
          lastHash: Schema.optional(Hash),
        }),
      ),
    ),
  ),
  ownershipIssues: Schema.mutableKey(Schema.optional(Schema.mutable(Schema.Array(OwnershipIssue)))),
  scanIssues: Schema.mutableKey(Schema.optional(Schema.mutable(Schema.Array(InventoryScanIssue)))),
  assessmentAcceptances: Schema.mutableKey(
    Schema.optional(Schema.mutable(Schema.Array(SkillAssessmentAcceptance))),
  ),
} as const;

/** The accepted remote head is saved atomically with the Library it describes. */
export const SyncAncestry = Schema.Struct({
  origin: Schema.NonEmptyString,
  library_id: Schema.NonEmptyString,
  revision_id: Schema.NonEmptyString,
  base_manifest: LibraryManifest,
});
export interface SyncAncestry extends Schema.Schema.Type<typeof SyncAncestry> {}
export const CURRENT_LIBRARY_STATE_VERSION = 12 as const;

/** State fields a publication replaces; operation history is deliberately separate. */
export const LibraryStateFields = {
  ...LibraryDeviceStateFields,
  schemaVersion: Schema.Literal(CURRENT_LIBRARY_STATE_VERSION),
  sync_ancestry: Schema.optionalKey(SyncAncestry),
  device_skill_selection: Schema.optionalKey(DeviceSkillSelection),
  pending_device_selection_origin: Schema.optionalKey(Schema.NonEmptyString),
  collections: Schema.mutable(Schema.Array(Collection)),
  skills: Schema.mutable(Schema.Array(Skill)),
  collection_versions: Schema.mutable(Schema.Array(CollectionVersion)),
  imports: Schema.mutable(Schema.Array(Import)),
  /** What is enabled for every project: the account's selection, as this device last saw it. */
  enabled: Schema.mutable(Schema.Array(Enabled)),
  invocation_policies: Schema.optionalKey(InvocationPolicies),
  repositories: Schema.mutable(Schema.Array(Repository)),
  installed_skills: Schema.mutable(Schema.Array(InstalledSkill)),
};
