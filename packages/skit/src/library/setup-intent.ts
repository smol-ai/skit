// What a setup's record keeps of the Library, before any step runs and once it finishes or stops
// (architecture/app.ts: setup intent carries prior and expected-after evidence in the same write).

import {
  currentCollectionSkills,
  currentSkillVersion,
  sourceImports,
} from "./library-contracts.js";
import type { LibraryState } from "./library-state.js";
import type { RecordedLibrary, SetupIntent } from "./store/state-schema.js";

export { SetupIntent, RecordedLibrary } from "./store/state-schema.js";

const withPolicies = (invocation_policies: LibraryState["invocation_policies"]) =>
  invocation_policies === undefined ? {} : { invocation_policies };

/** The desired fields of `state` a setup can change. */
export const setupIntent = (state: LibraryState): SetupIntent => ({
  global: { enabled: [...state.enabled], ...withPolicies(state.invocation_policies) },
  repositories: structuredClone(state.repositories),
  device: structuredClone(state.device_skill_selection ?? null),
  sources: state.collections
    .flatMap((collection) => {
      const selected = sourceImports(state, collection.collection_id)[0];
      return selected
        ? [
            {
              collectionId: collection.collection_id,
              importId: selected.import_id,
              collectionVersionId: selected.collection_version_id,
            },
          ]
        : [];
    })
    .sort((left, right) => left.collectionId.localeCompare(right.collectionId)),
  memberships: state.collections
    .map((collection) => ({
      collectionId: collection.collection_id,
      skillIds: currentCollectionSkills(state, collection.collection_id)
        .map((skill) => skill.skill_id)
        .sort(),
    }))
    .sort((left, right) => left.collectionId.localeCompare(right.collectionId)),
  versions: state.skills
    .map((skill) => ({
      skillId: skill.skill_id,
      selected: currentSkillVersion(state, skill)?.skill_version_id ?? null,
      local: skill.local_version_id ?? null,
    }))
    .sort((left, right) => left.skillId.localeCompare(right.skillId)),
});

/** What a setup's record keeps of `state`. */
export const recordedLibrary = (state: LibraryState): RecordedLibrary => ({
  intent: setupIntent(state),
  installedSkills: structuredClone(state.installed_skills),
});
