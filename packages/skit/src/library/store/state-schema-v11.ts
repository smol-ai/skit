import { Schema, SchemaGetter } from "effect";
import {
  CURRENT_LIBRARY_STATE_VERSION,
  LibraryState,
  LibraryStateDocument,
} from "../library-state.js";

import {
  Collection,
  Skill,
  CollectionVersion,
  Import,
  Enabled,
  Repository,
  InstalledSkill,
  DeviceSkillSelection,
  SkillAssessmentAcceptance,
  OwnershipIssue,
  InventoryScanIssue,
  SyncAncestry,
} from "./state-records-v11.js";
import { SkillId } from "../entity-ids.js";
import { Hash } from "../../shared/hash.js";

// Frozen v11 state. Every older state migrates through this shape, so it stays as v11 defined it
// while the current model moves on.

export const LibraryStateV11 = Schema.Struct({
  schemaVersion: Schema.Literal(11),
  unmanaged: Schema.mutableKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          harness: Schema.Literals(["codex", "claude-code", "opencode", "devin"]),
          harnesses: Schema.optional(
            Schema.mutable(
              Schema.Array(Schema.Literals(["codex", "claude-code", "opencode", "devin"])),
            ),
          ),
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
  sync_ancestry: Schema.optionalKey(SyncAncestry),
  device_skill_selection: Schema.optionalKey(DeviceSkillSelection),
  pending_device_selection_origin: Schema.optionalKey(Schema.NonEmptyString),
  collections: Schema.mutable(Schema.Array(Collection)),
  skills: Schema.mutable(Schema.Array(Skill)),
  collection_versions: Schema.mutable(Schema.Array(CollectionVersion)),
  imports: Schema.mutable(Schema.Array(Import)),
  enabled: Schema.mutable(Schema.Array(Enabled)),
  invocation_policies: Schema.optionalKey(
    Schema.Record(SkillId, Schema.Literals(["explicit", "implicit", "host-policy"])),
  ),
  repositories: Schema.mutable(Schema.Array(Repository)),
  installed_skills: Schema.mutable(Schema.Array(InstalledSkill)),
});
export type LibraryStateV11 = typeof LibraryStateV11.Type;

/** v11 → current: a v11 Library has no operation records to translate. */
export const LibraryStateFromV11 = Schema.Unknown.pipe(
  Schema.refine(Schema.is(LibraryStateV11)),
  Schema.decodeTo(LibraryStateDocument, {
    decode: SchemaGetter.transform((state: LibraryStateV11): LibraryState => ({
      ...state,
      schemaVersion: CURRENT_LIBRARY_STATE_VERSION,
      operations: [],
      // Historical prose cannot establish a more precise marker diagnosis.
      ...(state.ownershipIssues === undefined
        ? {}
        : {
            ownershipIssues: state.ownershipIssues.map(({ detail: _detail, ...issue }) => issue),
          }),
      installed_skills: state.installed_skills.map((copy) =>
        copy.status === "conflicted" ? { ...copy, conflicts: [] } : copy,
      ),
    })),
    encode: SchemaGetter.forbiddenEncoding,
  }),
);
