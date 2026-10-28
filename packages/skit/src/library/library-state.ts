import { createHash } from "node:crypto";
import { Effect, Schema, Struct } from "effect";
import { isAbsolute, resolve } from "node:path";
import { InstalledSkillId, SkillId, SkillVersionId } from "./entity-ids.js";
import {
  Import,
  Collection,
  Enabled,
  currentLibraryManifest,
  LibraryManifest,
  CollectionVersion,
  Skill,
  librarySnapshotDigests,
} from "./library-contracts.js";
import { HarnessInstallStatus, LibraryDeviceStateFields } from "./store/state-schema.js";
import { Digest, InvocationPolicy, RecordedInstallDestination } from "../vocabulary.js";
import { canonicalJson } from "../shared/json.js";

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

export const InstalledSkill = Schema.Struct({
  installed_skill_id: InstalledSkillId,
  skill_id: SkillId,
  skill_version_id: SkillVersionId,
  destination: RecordedInstallDestination,
  root: AbsoluteDevicePath,
  path: AbsoluteDevicePath,
  expected_digest: Digest,
  observed_digest: Schema.mutableKey(Schema.optional(Digest)),
  status: Schema.mutableKey(HarnessInstallStatus),
  suppression_reason: Schema.mutableKey(Schema.optional(Schema.Literal("native_delete"))),
  suppressed_at: Schema.mutableKey(Schema.optional(Schema.String)),
  installed_at: Schema.String,
});
export interface InstalledSkill extends Schema.Schema.Type<typeof InstalledSkill> {}

/**
 * The portable Library this state was last reconciled with. It lives in the same document as the
 * state it describes so that no write, crash, or restore can pair state with a newer base.
 */
export const SyncAncestry = Schema.Struct({
  origin: Schema.NonEmptyString,
  library_id: Schema.NonEmptyString,
  revision_id: Schema.NonEmptyString,
  base_manifest: LibraryManifest,
});
export interface SyncAncestry extends Schema.Schema.Type<typeof SyncAncestry> {}

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

export const CURRENT_LIBRARY_STATE_VERSION = 10 as const;

export const LibraryState = Schema.Struct({
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
}).check(
  Schema.makeFilter(
    (state) => {
      const skills = new Map(state.skills.map((skill) => [skill.skill_id, skill]));
      const collections = new Set(state.collections.map((collection) => collection.collection_id));
      const repositoryRoots = state.repositories.map((repository) => resolve(repository.root));
      const projectionCoordinates = state.installed_skills.map((projection) =>
        resolve(projection.path),
      );
      return (
        new Set(repositoryRoots).size === repositoryRoots.length &&
        new Set(projectionCoordinates).size === projectionCoordinates.length &&
        new Set(state.installed_skills.map((projection) => projection.installed_skill_id)).size ===
          state.installed_skills.length &&
        state.repositories.every((repository) =>
          repository.enabled.every((item) =>
            "skill" in item ? skills.has(item.skill) : collections.has(item.collection),
          ),
        ) &&
        state.installed_skills.every((projection) => {
          const skill = skills.get(projection.skill_id);
          return skill?.versions.some(
            (version) => version.skill_version_id === projection.skill_version_id,
          );
        })
      );
    },
    { message: "Repositories and installed skills must name retained entities" },
  ),
);
export interface LibraryState extends Schema.Schema.Type<typeof LibraryState> {}

export { globalEnabled, enabledAt, setEnabledAt, pruneEmptyEnabled } from "./enabled.js";

export const currentLibraryState = (fields: Omit<LibraryState, "schemaVersion">): LibraryState => ({
  ...fields,
  schemaVersion: CURRENT_LIBRARY_STATE_VERSION,
});

/** What a Library that has never been written loads as. */
export const emptyLibraryState = (): LibraryState =>
  currentLibraryState({
    collections: [],
    skills: [],
    collection_versions: [],
    imports: [],
    enabled: [],
    repositories: [],
    installed_skills: [],
    unmanaged: [],
  });

/** Content identity of a state; a save is accepted only onto the revision it was planned from. */
export const libraryStateRevision = (state: LibraryState): string =>
  createHash("sha256").update(canonicalJson(state)).digest("hex");

export const LibraryInventory = LibraryState.mapFields(
  Struct.omit([
    "schemaVersion",
    "assessmentAcceptances",
    "sync_ancestry",
    "device_skill_selection",
    "pending_device_selection_origin",
    "collections",
    "collection_versions",
    "imports",
    "enabled",
    "invocation_policies",
    "repositories",
  ]),
);
export type LibraryInventory = typeof LibraryInventory.Type;

// State schemas validate JSON without transformations. Refining the original value keeps
// unknown fields at every depth now that Effect no longer offers `preserve` parsing, so loading
// and saving state preserve them. A workflow that rebuilds state through `LibraryState`, as
// sync does, keeps only declared fields: a persisted field that matters needs a version bump.
export const LibraryStateDocument = Schema.Unknown.pipe(Schema.refine(Schema.is(LibraryState)));
export const decodeLibraryState = Schema.decodeUnknownEffect(LibraryStateDocument);
export const encodeLibraryState = Schema.encodeEffect(
  Schema.fromJsonString(LibraryStateDocument, { space: 2 }),
);

export const libraryManifestFromLocalState = Effect.fn("Library.libraryManifestFromLocalState")(
  function* (state: LibraryState) {
    const snapshot_digests = librarySnapshotDigests(state);
    return yield* LibraryManifest.makeEffect(
      currentLibraryManifest({
        collections: state.collections,
        skills: state.skills,
        collection_versions: state.collection_versions,
        imports: state.imports,
        snapshot_digests,
        enabled: state.enabled,
      }),
    );
  },
);
