import { localStateViolationIssue } from "./local-state-violation.js";
import { createHash } from "node:crypto";
import { Effect, Schema, Struct } from "effect";
import { resolve } from "node:path";
import {
  currentLibraryManifest,
  LibraryManifest,
  librarySnapshotDigests,
} from "./library-contracts.js";
import {
  LibraryStateFields,
  OperationStatus,
  CURRENT_LIBRARY_STATE_VERSION,
} from "./store/state-schema.js";
import { canonicalJson } from "../shared/json.js";

export { CURRENT_LIBRARY_STATE_VERSION } from "./store/state-schema.js";

export const LibraryState = Schema.Struct({
  ...LibraryStateFields,
  /** Operation records are local; a Sync publication never embeds them. */
  operations: Schema.Array(Schema.toEncoded(OperationStatus)),
}).check(
  Schema.makeFilter((state) => {
    const skills = new Map(state.skills.map((skill) => [skill.skill_id, skill]));
    const collections = new Set(state.collections.map((collection) => collection.collection_id));
    const roots = new Map<string, string>();
    for (const repository of state.repositories) {
      const canonical = resolve(repository.root);
      const first = roots.get(canonical);
      if (first !== undefined)
        return localStateViolationIssue(["repositories"], {
          _tag: "RepositoryRootCollision",
          first,
          second: repository.root,
          canonical,
        });
      roots.set(canonical, repository.root);
    }
    const paths = new Map<string, (typeof state.installed_skills)[number]>();
    const ids = new Set<string>();
    for (const installed of state.installed_skills) {
      const canonical = resolve(installed.path);
      const first = paths.get(canonical);
      if (first !== undefined)
        return localStateViolationIssue(["installed_skills"], {
          _tag: "InstalledPathCollision",
          firstId: first.installed_skill_id,
          secondId: installed.installed_skill_id,
          firstPath: first.path,
          secondPath: installed.path,
          canonical,
        });
      paths.set(canonical, installed);
      if (ids.has(installed.installed_skill_id))
        return localStateViolationIssue(["installed_skills"], {
          _tag: "InstalledIdDuplicate",
          installedSkillId: installed.installed_skill_id,
        });
      ids.add(installed.installed_skill_id);
    }
    for (const repository of state.repositories) {
      for (const item of repository.enabled) {
        if ("skill" in item ? !skills.has(item.skill) : !collections.has(item.collection))
          return localStateViolationIssue(["repositories"], {
            _tag: "RepositorySubjectMissing",
            root: repository.root,
            ...("skill" in item
              ? { kind: "skill" as const, id: item.skill }
              : { kind: "collection" as const, id: item.collection }),
          });
      }
    }
    for (const installed of state.installed_skills) {
      const skill = skills.get(installed.skill_id);
      if (skill === undefined)
        return localStateViolationIssue(["installed_skills"], {
          _tag: "InstalledSkillMissing",
          installedSkillId: installed.installed_skill_id,
          skillId: installed.skill_id,
          path: installed.path,
        });
      if (
        !skill.versions.some((version) => version.skill_version_id === installed.skill_version_id)
      )
        return localStateViolationIssue(["installed_skills"], {
          _tag: "InstalledVersionMissing",
          installedSkillId: installed.installed_skill_id,
          skillId: installed.skill_id,
          versionId: installed.skill_version_id,
          path: installed.path,
        });
    }
    return true;
  }),
);
export namespace LibraryState {
  export interface Type extends Schema.Schema.Type<typeof LibraryState> {}
  export interface Encoded extends Schema.Codec.Encoded<typeof LibraryState> {}
}
export type LibraryState = LibraryState.Type;

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
  Struct.pick(["unmanaged", "ownershipIssues", "scanIssues", "skills", "installed_skills"]),
);
export type LibraryInventory = typeof LibraryInventory.Type;

/** Project the public inventory without carrying private Library operations or device choices. */
export const libraryInventory = (state: LibraryState): LibraryInventory =>
  Struct.pick(state, Struct.keys(LibraryInventory.fields));

// State schemas validate JSON without transformations. Refining the original value keeps
// unknown fields at every depth now that Effect no longer offers `preserve` parsing, so loading
// and saving state preserve them. A workflow that rebuilds state through `LibraryState`, as
// sync does, keeps only declared fields: a persisted field that matters needs a version bump.
const LibraryStateValue = Schema.toType(LibraryState);
export const LibraryStateDocument = Schema.declareConstructor<LibraryState>()(
  [],
  () => (value, _ast, options) =>
    Schema.decodeUnknownEffect(LibraryStateValue)(value, options).pipe(
      // State fields have no transformations. Keep the validated original, including extension
      // fields at every depth, instead of the decoder's projection onto declared fields.
      Effect.map(() => value as LibraryState),
      Effect.mapError((error) => error.issue),
    ),
  { identifier: "LibraryStateDocument", toCodecJson: () => undefined },
);
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
