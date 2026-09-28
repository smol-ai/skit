import {
  bindingSkillIds,
  removeCollectionEffect,
  SkillRemovalRequiresCollection,
  type LibraryState,
} from "@smolai/skit-core";
import { Effect } from "effect";
import { resolveLibrarySubject } from "./subject-resolution.js";

export interface RemoveOptions {
  readonly query: string;
  readonly dryRun: boolean;
  readonly variantsPath: string;
}

export const planRemoveEffect = Effect.fn("Library.planRemove")(function* (
  state: LibraryState,
  query: string,
) {
  const subject = yield* resolveLibrarySubject(state, query);
  // A Source is its whole repository: one of its Skills cannot be removed, only disabled.
  if (subject.kind === "skill")
    return yield* new SkillRemovalRequiresCollection({
      skill_id: subject.skill.skill_id,
      collection_id: subject.skill.collection_id,
    });
  const skills = subject.skills;
  return {
    subject_id: subject.subjectId,
    subject_kind: subject.kind,
    versions: skills.reduce((count, skill) => count + skill.versions.length, 0),
    skills: skills.length,
    global_bindings: state.global_bindings.filter((binding) =>
      bindingSkillIds(state, binding).some((skillId) =>
        skills.some((skill) => skill.skill_id === skillId),
      ),
    ).length,
    repository_bindings: state.local_bindings.filter((binding) =>
      bindingSkillIds(state, binding).some((skillId) =>
        skills.some((skill) => skill.skill_id === skillId),
      ),
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
  // Planning refuses a single Skill, so only a Collection reaches removal.
  const removed = yield* removeCollectionEffect({
    collectionId: plan.subject_id,
    variantsPath: options.variantsPath,
  });
  return { kind: "removed" as const, value: { ...plan, retired: removed.retired } };
});
