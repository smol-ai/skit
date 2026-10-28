import { Schema, SchemaGetter } from "effect";
import { CollectionId, InstalledSkillId, SkillId, SkillVersionId } from "../entity-ids.js";
import { Collection } from "../library-contracts.js";
import {
  AbsoluteDevicePath,
  CURRENT_LIBRARY_STATE_VERSION,
  LibraryStateDocument,
} from "../library-state.js";
import {
  Hash,
  HarnessName,
  InvocationPolicy,
  RecordedInstallDestination,
} from "../../vocabulary.js";
import {
  BindingEntryV7,
  BindingV7,
  collectionVersionFromV7,
  CollectionVersionV7,
  enabledFromV7,
  importFromV7,
  ImportV7,
  libraryManifestFromV7,
  LibraryManifestV7,
  skillFromV7,
  SkillV7,
} from "./manifest-v7.js";
import {
  HarnessInstallStatus,
  InventoryScanIssue,
  SkillAssessmentAcceptance,
} from "./state-schema.js";

/** An assessment acceptance as v9 stored it: the content hash was `artifactContentDigest`. */
const { artifactContentHash: _contentHash, ...acceptanceFields } = SkillAssessmentAcceptance.fields;
const SkillAssessmentAcceptanceV9 = Schema.Struct({
  ...acceptanceFields,
  artifactContentDigest: Hash,
});

// Frozen v9 state. Every older state migrates through these shapes, so they stay as v9 defined
// them while the current model moves on.

export const InstalledSkillV9 = Schema.Struct({
  projection_id: InstalledSkillId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  target: RecordedInstallDestination,
  root: AbsoluteDevicePath,
  path: AbsoluteDevicePath,
  expected_digest: Hash,
  observed_digest: Schema.optional(Hash),
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
  observedHash: Hash,
  detail: Schema.optional(Schema.String),
  collectionId: Schema.optional(CollectionId),
  skillId: Schema.optional(SkillId),
  projectionId: Schema.optional(InstalledSkillId),
  expectedHash: Schema.optional(Hash),
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
      observedHash: Hash,
      lastObservedHash: Schema.optional(Hash),
    }),
  ),
  custodyIssues: Schema.optional(Schema.Array(OwnershipIssueV9)),
  scanIssues: Schema.optional(Schema.Array(InventoryScanIssue)),
  assessmentAcceptances: Schema.optional(Schema.Array(SkillAssessmentAcceptanceV9)),
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
  skills: Schema.Array(SkillV7),
  retained_copies: Schema.Array(CollectionVersionV7),
  acquisitions: Schema.Array(ImportV7),
  global_bindings: Schema.Array(DeviceBindingV9),
  local_bindings: Schema.Array(RepositoryBindingV9),
  projections: Schema.Array(InstalledSkillV9),
});
export type LibraryStateV9 = typeof LibraryStateV9.Type;

const policies = (invocation_policies: Readonly<Record<string, InvocationPolicy>> | undefined) =>
  invocation_policies === undefined ? {} : { invocation_policies };

export const DeviceSkillSelectionV9 = LibraryStateV9.fields.device_skill_selection.schema;
export type DeviceSkillSelectionV9 = typeof DeviceSkillSelectionV9.Type;

export const installedSkillFromV9 = ({
  projection_id,
  target,
  projected_at,
  observed_digest,
  expected_digest,
  ...copy
}: typeof InstalledSkillV9.Type) => ({
  ...copy,
  expected_hash: expected_digest,
  installed_skill_id: projection_id,
  destination: target,
  installed_at: projected_at,
  ...(observed_digest === undefined ? {} : { current_hash: observed_digest }),
});

export const repositoryFromV9 = (binding: typeof RepositoryBindingV9.Type) => ({
  root: binding.scope.root,
  enabled: enabledFromV7(binding.entries),
  ...policies(binding.invocation_policies),
});

/** The global list a v9 global Binding held; none means nothing enabled. */
export const globalFromV9 = (binding: typeof DeviceBindingV9.Type | undefined) => ({
  enabled: binding === undefined ? [] : enabledFromV7(binding.entries),
  ...policies(binding?.invocation_policies),
});

export const deviceSelectionFromV9 = (selection: DeviceSkillSelectionV9) =>
  selection.mode === "choose"
    ? { mode: "choose" as const, ...globalFromV9(selection.binding) }
    : selection;

/**
 * v9 → v10: Bindings become plain lists of enabled items held where they apply (the Library, each
 * repository, the device's own choice), and stored records take plain names.
 */
const libraryStateFromV9 = ({
  schemaVersion: _schemaVersion,
  sync_ancestry,
  device_skill_selection,
  retained_copies,
  acquisitions,
  global_bindings,
  local_bindings,
  projections,
  custodyIssues,
  unmanaged,
  skills,
  assessmentAcceptances,
  ...fields
}: LibraryStateV9) => {
  return {
    ...fields,
    schemaVersion: CURRENT_LIBRARY_STATE_VERSION,
    ...(sync_ancestry === undefined
      ? {}
      : {
          sync_ancestry: {
            ...sync_ancestry,
            base_manifest: libraryManifestFromV7(sync_ancestry.base_manifest),
          },
        }),
    ...(device_skill_selection === undefined
      ? {}
      : { device_skill_selection: deviceSelectionFromV9(device_skill_selection) }),
    collection_versions: retained_copies.map(collectionVersionFromV7),
    imports: acquisitions.map(importFromV7),
    ...globalFromV9(global_bindings[0]),
    repositories: local_bindings.map(repositoryFromV9),
    skills: skills.map(skillFromV7),
    ...(assessmentAcceptances === undefined
      ? {}
      : {
          assessmentAcceptances: assessmentAcceptances.map(
            ({ artifactContentDigest, ...acceptance }) => ({
              ...acceptance,
              artifactContentHash: artifactContentDigest,
            }),
          ),
        }),
    installed_skills: projections.map(installedSkillFromV9),
    unmanaged: unmanaged.map(({ observedHash, lastObservedHash, ...copy }) => ({
      ...copy,
      currentHash: observedHash,
      ...(lastObservedHash === undefined ? {} : { lastHash: lastObservedHash }),
    })),
    ...(custodyIssues === undefined
      ? {}
      : {
          ownershipIssues: custodyIssues.map(({ code, projectionId, observedHash, ...issue }) => ({
            ...issue,
            currentHash: observedHash,
            code: code === "ORPHANED_PROJECTION_CLAIM" ? "ORPHANED_OWNERSHIP_MARKER" : code,
            ...(projectionId === undefined ? {} : { installedSkillId: projectionId }),
          })),
        }),
  };
};

export const LibraryStateFromV9 = Schema.Unknown.pipe(
  Schema.refine(Schema.is(LibraryStateV9)),
  Schema.decodeTo(LibraryStateDocument, {
    decode: SchemaGetter.transform(libraryStateFromV9),
    encode: SchemaGetter.forbidden(() => "v9 Library state is decode-only"),
  }),
);
