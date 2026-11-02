import { Schema, SchemaGetter } from "effect";
import { InstalledSkillId, SkillId, SkillVersionId } from "../entity-ids.js";
import {
  AbsoluteDevicePath,
  CURRENT_LIBRARY_STATE_VERSION,
  LibraryState,
  LibraryStateDocument,
  type InstalledSkill,
} from "../library-state.js";
import { Hash, RecordedInstallDestination } from "../../vocabulary.js";
import { HarnessInstallStatus } from "./state-schema.js";

// Frozen v10 state. Every older state migrates through these shapes, so they stay as v10 defined
// them while the current model moves on.

/** One status plus optional fields, any of which any status could carry. */
export const InstalledSkillV10 = Schema.Struct({
  installed_skill_id: InstalledSkillId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  destination: RecordedInstallDestination,
  root: AbsoluteDevicePath,
  path: AbsoluteDevicePath,
  expected_hash: Hash,
  current_hash: Schema.optional(Hash),
  status: HarnessInstallStatus,
  suppression_reason: Schema.optional(Schema.Literal("native_delete")),
  suppressed_at: Schema.optional(Schema.String),
  installed_at: Schema.String,
});
export type InstalledSkillV10 = typeof InstalledSkillV10.Type;

const {
  schemaVersion: _schemaVersion,
  installed_skills: _installedSkills,
  ...fields
} = LibraryState.fields;
export const LibraryStateV10 = Schema.Struct({
  ...fields,
  schemaVersion: Schema.Literal(10),
  installed_skills: Schema.Array(InstalledSkillV10),
});
export type LibraryStateV10 = typeof LibraryStateV10.Type;

/**
 * Each status keeps only the fields it uses. A copy whose record cannot say what is on disk becomes
 * pending, so SKIT checks its folder again: no released SKIT wrote `drifted` or `unsupported`, and a
 * conflicted copy without the hash SKIT found is not one SKIT can describe.
 */
export const installedSkillFromV10 = ({
  current_hash,
  status,
  suppression_reason: _suppressionReason,
  suppressed_at,
  ...copy
}: InstalledSkillV10): InstalledSkill => {
  switch (status) {
    case "installed":
      return { ...copy, status };
    case "conflicted":
      return current_hash === undefined
        ? { ...copy, status: "pending" }
        : { ...copy, status, current_hash };
    case "suppressed":
      return {
        ...copy,
        status,
        suppression_reason: "native_delete",
        ...(suppressed_at === undefined ? {} : { suppressed_at }),
      };
    case "pending":
    case "drifted":
    case "unsupported":
      return { ...copy, status: "pending" };
  }
};

/** v10 → v11: an installed copy records only the fields its status uses. */
export const LibraryStateFromV10 = Schema.Unknown.pipe(
  Schema.refine(Schema.is(LibraryStateV10)),
  Schema.decodeTo(LibraryStateDocument, {
    decode: SchemaGetter.transform(
      ({ installed_skills, ...state }: LibraryStateV10): LibraryState => ({
        ...state,
        schemaVersion: CURRENT_LIBRARY_STATE_VERSION,
        installed_skills: installed_skills.map(installedSkillFromV10),
      }),
    ),
    encode: SchemaGetter.forbidden(() => "v10 Library state is decode-only"),
  }),
);
