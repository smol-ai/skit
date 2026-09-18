import { LibraryStore, type LibraryState } from "@smolai/skit-core";
import { Effect, Schema } from "effect";
import type { InventoryRootOptions } from "../../projection/roots.js";
import { reconcileLibraryProjections } from "./projection-reconciliation.js";
import {
  addPortableLibrarySourceEffect,
  inspectPortableLibrarySourceEffect,
  type PortableAddOptions,
} from "./portable-add.js";

export class PortablePinNotFound extends Schema.TaggedError<PortablePinNotFound>()(
  "Library.PortablePinNotFound",
  { query: Schema.String, version: Schema.String },
) {
  readonly code = "NOT_FOUND" as const;
  readonly exitCode = 11;
  readonly remediation = "Run `skit inspect` to find a retained Skill Version ID.";
}
export class PortablePinAmbiguous extends Schema.TaggedError<PortablePinAmbiguous>()(
  "Library.PortablePinAmbiguous",
  { query: Schema.String, version: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Use a Skill ID and Skill Version ID.";
}
export class PortablePinBindingInvalid extends Schema.TaggedError<PortablePinBindingInvalid>()(
  "Library.PortablePinBindingInvalid",
  { collection_id: Schema.String, skill: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Select a Version retained for this Skill.";
}
export class PortablePinHistoricalUnsupported extends Schema.TaggedError<PortablePinHistoricalUnsupported>()(
  "Library.PortablePinHistoricalUnsupported",
  { collection_id: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Historical release pinning requires a retained Registry source.";
}

export interface PortablePinOptions extends PortableAddOptions {
  readonly query: string;
  readonly version: string;
  readonly dryRun: boolean;
  readonly roots: InventoryRootOptions;
  readonly variantsPath: string;
}

const selectSkills = Effect.fn("Library.selectPortablePinSkills")(function* (
  state: LibraryState,
  query: string,
  version: string,
) {
  const collections = state.collections.filter((collection) =>
    [collection.collection_id, collection.display_name].includes(query),
  );
  if (collections.length > 1) return yield* new PortablePinAmbiguous({ query, version });
  if (collections.length === 1)
    return state.skills.filter((skill) => skill.collection_id === collections[0]!.collection_id);
  const candidates = state.skills.filter(
    (skill) =>
      skill.skill_id === query ||
      skill.name === query ||
      skill.versions.some((candidate) => candidate.skill_version_id === query),
  );
  if (candidates.length === 0) return yield* new PortablePinNotFound({ query, version });
  if (candidates.length !== 1) return yield* new PortablePinAmbiguous({ query, version });
  return candidates;
});

const acquisitionFor = (state: LibraryState, skill: LibraryState["skills"][number]) => {
  const ids = new Set(
    skill.versions.flatMap((candidate) => candidate.origins.map((origin) => origin.acquisition_id)),
  );
  return state.acquisitions
    .filter((candidate) => ids.has(candidate.acquisition_id))
    .reduce<(typeof state.acquisitions)[number] | undefined>(
      (latest, candidate) =>
        latest === undefined || candidate.acquired_at >= latest.acquired_at ? candidate : latest,
      undefined,
    );
};

export const planPortablePinEffect = Effect.fn("Library.planPortablePin")(function* (
  state: LibraryState,
  options: PortablePinOptions,
) {
  const skills = yield* selectSkills(state, options.query, options.version);
  const retainedMatches = skills.flatMap((skill) =>
    skill.versions
      .filter((candidate) => candidate.skill_version_id === options.version)
      .map((version) => ({ skill, version })),
  );
  if (retainedMatches.length > 1)
    return yield* new PortablePinAmbiguous({ query: options.query, version: options.version });
  const historical = retainedMatches.length === 0;
  const acquisition = historical ? acquisitionFor(state, skills[0]!) : undefined;
  if (historical && acquisition?.source_identity.kind !== "registry")
    return yield* new PortablePinHistoricalUnsupported({ collection_id: skills[0]!.collection_id });
  const inspected = historical
    ? yield* inspectPortableLibrarySourceEffect(options, acquisition!.input.value, options.version)
    : undefined;
  const selectedSkills = historical ? skills : [retainedMatches[0]!.skill];
  return {
    collection_id: selectedSkills[0]!.collection_id,
    skills: selectedSkills.map((skill) => {
      const version = skill.versions.find(
        (candidate) => candidate.skill_version_id === options.version,
      );
      return {
        skill_id: skill.skill_id,
        skill: skill.name,
        ...(skill.selected_skill_version_id === undefined
          ? {}
          : { current_version_id: skill.selected_skill_version_id }),
        ...(version === undefined ? {} : { selected_version_id: version.skill_version_id }),
      };
    }),
    ...(historical ? { requested_version: options.version } : {}),
    ...(inspected === undefined ? {} : { snapshot_digest: inspected.snapshot_digest }),
    retained: !historical,
    changed:
      historical ||
      selectedSkills.some((skill) => skill.selected_skill_version_id !== options.version),
    bindings: [...state.global_bindings, ...state.local_bindings].filter(
      (binding) =>
        binding.collection_id === selectedSkills[0]!.collection_id &&
        binding.skills.some((skillId) =>
          selectedSkills.some((skill) => skill.skill_id === skillId),
        ),
    ).length,
  };
});

export const executePortablePinEffect = Effect.fn("Library.executePortablePin")(function* (
  state: LibraryState,
  options: PortablePinOptions,
) {
  const plan = yield* planPortablePinEffect(state, options);
  if (options.dryRun) return { kind: "plan" as const, value: plan };
  const store = yield* LibraryStore;
  if (!plan.retained) {
    const acquisition = acquisitionFor(
      state,
      (yield* selectSkills(state, options.query, options.version))[0]!,
    );
    if (acquisition?.source_identity.kind !== "registry")
      return yield* new PortablePinHistoricalUnsupported({ collection_id: plan.collection_id });
    yield* addPortableLibrarySourceEffect(
      { ...options, selectVersions: false },
      acquisition.input.value,
      options.version,
    );
  }
  const retained = yield* store.load;
  const selections = plan.skills.map((planned) => {
    const target = retained.skills.find((skill) => skill.skill_id === planned.skill_id);
    const selected =
      planned.selected_version_id === undefined
        ? target?.versions.find((version) => {
            const acquisitionIds = new Set(version.origins.map((origin) => origin.acquisition_id));
            return retained.acquisitions.some(
              (candidate) =>
                acquisitionIds.has(candidate.acquisition_id) &&
                retained.retained_copies.some(
                  (copy) =>
                    copy.retained_copy_id === candidate.retained_copy_id &&
                    copy.digest === plan.snapshot_digest,
                ),
            );
          })
        : target?.versions.find(
            (version) => version.skill_version_id === planned.selected_version_id,
          );
    return { target, selected, planned };
  });
  if (selections.some(({ target, selected }) => target === undefined || selected === undefined))
    return yield* new PortablePinNotFound({ query: options.query, version: options.version });
  if (
    selections.some(
      ({ target, selected }) => target!.selected_skill_version_id !== selected!.skill_version_id,
    )
  )
    yield* store.publish({
      ...retained,
      skills: retained.skills.map((skill) =>
        selections.find(({ target }) => target?.skill_id === skill.skill_id)?.selected === undefined
          ? skill
          : {
              ...skill,
              selected_skill_version_id: selections.find(
                ({ target }) => target?.skill_id === skill.skill_id,
              )!.selected!.skill_version_id,
            },
      ),
    });
  const current = yield* store.load;
  const skillIds = plan.skills.map((skill) => skill.skill_id);
  const bindings = [...current.global_bindings, ...current.local_bindings].filter(
    (binding) =>
      binding.collection_id === plan.collection_id &&
      binding.skills.some((skillId) => skillIds.includes(skillId)),
  );
  const reconciled = yield* reconcileLibraryProjections({
    roots: options.roots,
    variantsPath: options.variantsPath,
    onlyBindings: bindings,
  });
  return {
    kind: "pinned" as const,
    value: {
      ...plan,
      skills: selections.map(({ planned, selected }) => ({
        ...planned,
        selected_version_id: selected!.skill_version_id,
      })),
      projected: reconciled.projected,
      deferred: reconciled.deferred,
    },
  };
});
