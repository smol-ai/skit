import { createHash } from "node:crypto";
import { Effect, Schema, Struct } from "effect";
import { resolve } from "node:path";
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
import { LibraryDeviceStateFields, OperationStatus } from "./store/state-schema.js";
import {
  DeviceSkillSelection,
  InstalledSkill,
  Repository,
  InvocationPolicies,
} from "./device-state.js";
import { canonicalJson } from "../shared/json.js";

export * from "./device-state.js";

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

export const CURRENT_LIBRARY_STATE_VERSION = 12 as const;

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
  /** Setup's operation records, as JSON. They stay on this device; sync and pack never send them. */
  operations: Schema.Array(Schema.toEncoded(OperationStatus)),
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
    operations: [],
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
    "operations",
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
