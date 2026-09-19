import { removeCollectionEffect, removeSkillEffect, type LibraryState } from "@smolai/skit-core";
import { Effect, Schema } from "effect";

export class RemoveNotFound extends Schema.TaggedError<RemoveNotFound>()("Library.RemoveNotFound", {
  query: Schema.String,
}) {
  readonly code = "NOT_FOUND" as const;
  readonly exitCode = 11;
  readonly remediation = "Run `skit list` to find a retained Collection.";
}
export class RemoveAmbiguous extends Schema.TaggedError<RemoveAmbiguous>()(
  "Library.RemoveAmbiguous",
  { query: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Use a Collection ID to name exactly one Collection.";
}

export interface RemoveOptions {
  readonly query: string;
  readonly dryRun: boolean;
  readonly variantsPath: string;
}

export const planRemoveEffect = Effect.fn("Library.planRemove")(function* (
  state: LibraryState,
  query: string,
) {
  const collections = state.collections.filter(
    (collection) =>
      [collection.collection_id, collection.label].includes(query) ||
      state.skills.some(
        (skill) =>
          skill.collection_id === collection.collection_id &&
          (skill.name === query ||
            skill.skill_id === query ||
            skill.versions.some((version) => version.skill_version_id === query)),
      ),
  );
  const standaloneSkills = state.skills.filter(
    (skill) =>
      skill.collection_id === undefined &&
      (skill.name === query ||
        skill.skill_id === query ||
        skill.versions.some((version) => version.skill_version_id === query)),
  );
  const matches = [
    ...collections.map((collection) => ({ kind: "collection" as const, collection })),
    ...standaloneSkills.map((skill) => ({ kind: "skill" as const, skill })),
  ];
  if (matches.length === 0) return yield* new RemoveNotFound({ query });
  if (matches.length !== 1) return yield* new RemoveAmbiguous({ query });
  const subject = matches[0];
  if (subject === undefined) return yield* new RemoveNotFound({ query });
  const skills =
    subject.kind === "collection"
      ? state.skills.filter((skill) => skill.collection_id === subject.collection.collection_id)
      : [subject.skill];
  return {
    subject_id:
      subject.kind === "collection" ? subject.collection.collection_id : subject.skill.skill_id,
    subject_kind: subject.kind,
    versions: skills.reduce((count, skill) => count + skill.versions.length, 0),
    skills: skills.length,
    global_bindings: state.global_bindings.filter((binding) =>
      binding.skills.some((skillId) => skills.some((skill) => skill.skill_id === skillId)),
    ).length,
    repository_bindings: state.local_bindings.filter((binding) =>
      binding.skills.some((skillId) => skills.some((skill) => skill.skill_id === skillId)),
    ).length,
    owned_projections: state.projections.filter((projection) =>
      skills.some((skill) => skill.skill_id === projection.skill_id),
    ).length,
  };
});

export const executeRemoveEffect = Effect.fn("Library.executeRemove")(function* (
  state: LibraryState,
  options: RemoveOptions,
) {
  const plan = yield* planRemoveEffect(state, options.query);
  if (options.dryRun) return { kind: "plan" as const, value: plan };
  const removed = yield* plan.subject_kind === "collection"
    ? removeCollectionEffect({
        collectionId: plan.subject_id,
        variantsPath: options.variantsPath,
      })
    : removeSkillEffect({
        skillId: plan.subject_id,
        variantsPath: options.variantsPath,
      });
  return { kind: "removed" as const, value: { ...plan, retired: removed.retired } };
});
