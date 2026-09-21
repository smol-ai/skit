import { LibraryStore, type LibraryState } from "@smolai/skit-core";
import { Effect, Schema } from "effect";
import type { InventoryRootOptions } from "../../projection/roots.js";
import { reconcileLibraryProjections } from "./projection-reconciliation.js";
import { addLibrarySourceEffect, inspectLibrarySourceEffect, type AddOptions } from "./add.js";
import { matchingLibrarySubjects } from "./subject-resolution.js";

export class PinNotFound extends Schema.TaggedError<PinNotFound>()("Library.PinNotFound", {
  query: Schema.String,
  version: Schema.String,
}) {
  readonly code = "NOT_FOUND" as const;
  readonly exitCode = 11;
  readonly remediation = "Run `skit inspect` to find a retained Skill Version ID.";
}
export class PinAmbiguous extends Schema.TaggedError<PinAmbiguous>()("Library.PinAmbiguous", {
  query: Schema.String,
  version: Schema.String,
}) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Use a Skill ID and Skill Version ID.";
}
export class PinBindingInvalid extends Schema.TaggedError<PinBindingInvalid>()(
  "Library.PinBindingInvalid",
  { collection_id: Schema.String, skill: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Select a Version retained for this Skill.";
}
export class PinHistoricalUnsupported extends Schema.TaggedError<PinHistoricalUnsupported>()(
  "Library.PinHistoricalUnsupported",
  { collection_id: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Historical release pinning requires a retained Registry source.";
}

export interface PinOptions extends AddOptions {
  readonly query: string;
  readonly version: string;
  readonly dryRun: boolean;
  readonly roots: InventoryRootOptions;
  readonly variantsPath: string;
}

const selectSkills = Effect.fn("Library.selectPinSkills")(function* (
  state: LibraryState,
  query: string,
  version: string,
) {
  const subjects = matchingLibrarySubjects(state, query);
  const collections = subjects.filter(
    (subject) =>
      subject.kind === "collection" &&
      [subject.collection.collection_id, subject.collection.label].includes(query),
  );
  if (collections.length > 1) return yield* new PinAmbiguous({ query, version });
  if (collections.length === 1) return collections[0]!.skills;
  const candidates = subjects.flatMap((subject) =>
    subject.skills.filter(
      (skill) =>
        skill.skill_id === query ||
        skill.name === query ||
        skill.versions.some((candidate) => candidate.skill_version_id === query),
    ),
  );
  if (candidates.length === 0) return yield* new PinNotFound({ query, version });
  if (candidates.length !== 1) return yield* new PinAmbiguous({ query, version });
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

export const planPinEffect = Effect.fn("Library.planPin")(function* (
  state: LibraryState,
  options: PinOptions,
) {
  const skills = yield* selectSkills(state, options.query, options.version);
  const retainedMatches = skills.flatMap((skill) =>
    skill.versions
      .filter((candidate) => candidate.skill_version_id === options.version)
      .map((version) => ({ skill, version })),
  );
  if (retainedMatches.length > 1)
    return yield* new PinAmbiguous({ query: options.query, version: options.version });
  const historical = retainedMatches.length === 0;
  const acquisition = historical ? acquisitionFor(state, skills[0]!) : undefined;
  if (historical && acquisition?.source_identity.kind !== "registry")
    return yield* new PinHistoricalUnsupported({
      collection_id: skills[0]!.collection_id ?? skills[0]!.skill_id,
    });
  const inspected = historical
    ? yield* inspectLibrarySourceEffect(options, acquisition!.input.value, options.version)
    : undefined;
  const selectedSkills = historical ? skills : [retainedMatches[0]!.skill];
  return {
    subject_id: selectedSkills[0]!.collection_id ?? selectedSkills[0]!.skill_id,
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
    bindings: [...state.global_bindings, ...state.local_bindings].filter((binding) =>
      binding.skills.some((skillId) => selectedSkills.some((skill) => skill.skill_id === skillId)),
    ).length,
  };
});

export const executePinEffect = Effect.fn("Library.executePin")(function* (
  state: LibraryState,
  options: PinOptions,
) {
  const plan = yield* planPinEffect(state, options);
  if (options.dryRun) return { kind: "plan" as const, value: plan };
  const store = yield* LibraryStore;
  if (!plan.retained) {
    const acquisition = acquisitionFor(
      state,
      (yield* selectSkills(state, options.query, options.version))[0]!,
    );
    if (acquisition?.source_identity.kind !== "registry")
      return yield* new PinHistoricalUnsupported({ collection_id: plan.subject_id });
    yield* addLibrarySourceEffect(
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
    return yield* new PinNotFound({ query: options.query, version: options.version });
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
  const bindings = [...current.global_bindings, ...current.local_bindings].filter((binding) =>
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
