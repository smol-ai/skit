import { Schema, SchemaGetter } from "effect";
import { CollectionId, InstalledSkillId, SkillId, SkillVersionId } from "../entity-ids.js";
import { Collection, Skill } from "../library-contracts.js";
import {
  AbsoluteDevicePath,
  CURRENT_LIBRARY_STATE_VERSION,
  LibraryStateDocument,
} from "../library-state.js";
import {
  Digest,
  HarnessName,
  InvocationPolicy,
  RecordedInstallDestination,
} from "../../vocabulary.js";
import {
  BindingEntryV7,
  BindingV7,
  CollectionVersionV7,
  ImportV7,
  LibraryManifestV7,
} from "./manifest-v7.js";
import {
  HarnessInstallStatus,
  InventoryScanIssue,
  SkillAssessmentAcceptance,
} from "./state-schema.js";

// Frozen v9 state. Every older state migrates through these shapes, so they stay as v9 defined
// them while the current model moves on.

export const InstalledSkillV9 = Schema.Struct({
  projection_id: InstalledSkillId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  target: RecordedInstallDestination,
  root: AbsoluteDevicePath,
  path: AbsoluteDevicePath,
  expected_digest: Digest,
  observed_digest: Schema.optional(Digest),
  status: HarnessInstallStatus,
  suppression_reason: Schema.optional(Schema.Literal("native_delete")),
  suppressed_at: Schema.optional(Schema.String),
  projected_at: Schema.String,
});

export const DeviceBindingV9 = Schema.Struct({
  ...BindingV7.fields,
  invocation_policies: Schema.optionalKey(Schema.Record(SkillId, InvocationPolicy)),
});

export const RepositoryBindingV9 = Schema.Struct({
  scope: Schema.Struct({ kind: Schema.Literal("repository"), root: AbsoluteDevicePath }),
  entries: Schema.Array(BindingEntryV7),
  invocation_policies: Schema.optionalKey(Schema.Record(SkillId, InvocationPolicy)),
});

const OwnershipIssueV9 = Schema.Struct({
  code: Schema.Literals(["ORPHANED_PROJECTION_CLAIM", "INVALID_OWNERSHIP_MARKER"]),
  path: Schema.String,
  canonicalPath: Schema.String,
  harnesses: Schema.Array(HarnessName),
  observedHash: Digest,
  detail: Schema.optional(Schema.String),
  collectionId: Schema.optional(CollectionId),
  skillId: Schema.optional(SkillId),
  projectionId: Schema.optional(InstalledSkillId),
  expectedHash: Schema.optional(Digest),
  matchesExpectedHash: Schema.optional(Schema.Boolean),
});

/** The device fields every state since v4 carries. */
export const LibraryDeviceStateFieldsV9 = {
  unmanaged: Schema.Array(
    Schema.Struct({
      harness: HarnessName,
      harnesses: Schema.optional(Schema.Array(HarnessName)),
      path: Schema.String,
      paths: Schema.optional(Schema.Array(Schema.String)),
      observedHash: Digest,
      lastObservedHash: Schema.optional(Digest),
    }),
  ),
  custodyIssues: Schema.optional(Schema.Array(OwnershipIssueV9)),
  scanIssues: Schema.optional(Schema.Array(InventoryScanIssue)),
  assessmentAcceptances: Schema.optional(Schema.Array(SkillAssessmentAcceptance)),
} as const;

export const LibraryStateV9 = Schema.Struct({
  ...LibraryDeviceStateFieldsV9,
  schemaVersion: Schema.Literal(9),
  sync_ancestry: Schema.optionalKey(
    Schema.Struct({
      origin: Schema.NonEmptyString,
      library_id: Schema.NonEmptyString,
      revision_id: Schema.NonEmptyString,
      base_manifest: LibraryManifestV7,
    }),
  ),
  device_skill_selection: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ mode: Schema.Literal("follow-account") }),
      Schema.Struct({ mode: Schema.Literal("choose"), binding: DeviceBindingV9 }),
    ]),
  ),
  pending_device_selection_origin: Schema.optionalKey(Schema.NonEmptyString),
  collections: Schema.Array(Collection),
  skills: Schema.Array(Skill),
  retained_copies: Schema.Array(CollectionVersionV7),
  acquisitions: Schema.Array(ImportV7),
  global_bindings: Schema.Array(DeviceBindingV9),
  local_bindings: Schema.Array(RepositoryBindingV9),
  projections: Schema.Array(InstalledSkillV9),
});
export type LibraryStateV9 = typeof LibraryStateV9.Type;

/** v9 → current. */
export const LibraryStateFromV9 = Schema.Unknown.pipe(
  Schema.refine(Schema.is(LibraryStateV9)),
  Schema.decodeTo(LibraryStateDocument, {
    decode: SchemaGetter.transform((state) => ({
      ...state,
      schemaVersion: CURRENT_LIBRARY_STATE_VERSION,
    })),
    encode: SchemaGetter.forbidden(() => "v9 Library state is decode-only"),
  }),
);
