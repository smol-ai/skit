import { markAuthorWorkspaceRemoved } from "../../library/author-workspace.js";
import { LibraryStore, withLibraryWriter } from "@smolai/skit-core";
import {
  enabledSkillIds,
  removeCollection,
  SkillRemovalRequiresCollection,
  type LibraryState,
} from "@smolai/skit-core";
import { Effect } from "effect";
import { resolveLibrarySubject } from "./subject-resolution.js";

export interface RemoveOptions {
  readonly query: string;
  readonly dryRun: boolean;
}

export const planRemove = Effect.fn("Library.planRemove")(function* (
  state: LibraryState,
  query: string,
) {
  const subject = yield* resolveLibrarySubject(state, query);
  // A Source is its whole repository: a Skill cannot be removed from a Collection with other
  // Skills (it would return on the next refresh), only disabled. A Collection of one Skill is
  // removed with it.
  if (
    subject.kind === "skill" &&
    state.skills.some(
      (candidate) =>
        candidate.collection_id === subject.skill.collection_id &&
        candidate.skill_id !== subject.skill.skill_id,
    )
  )
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
    global_enabled: [state.enabled].filter((enabled) =>
      enabledSkillIds(state, enabled).some((skillId) =>
        skills.some((skill) => skill.skill_id === skillId),
      ),
    ).length,
    repositories: state.repositories.filter((repository) =>
      enabledSkillIds(state, repository.enabled).some((skillId) =>
        skills.some((skill) => skill.skill_id === skillId),
      ),
    ).length,
    installed_skills: state.installed_skills.filter((installedSkill) =>
      skills.some((skill) => skill.skill_id === installedSkill.skill_id),
    ).length,
  };
});

export const executeRemove = Effect.fn("Library.executeRemove")(
  function* (state: LibraryState, options: RemoveOptions) {
    const plan = yield* planRemove(state, options.query);
    if (options.dryRun) return { kind: "plan" as const, value: plan };
    // Planning only admits a Skill that is its Collection's only Skill, so removal is of a Collection.
    // It removes exactly what was planned, and is refused if the Library has since moved on.
    const removed = yield* removeCollection(state, {
      collectionId:
        plan.subject_kind === "collection"
          ? plan.subject_id
          : (state.skills.find((skill) => skill.skill_id === plan.subject_id)?.collection_id ??
            plan.subject_id),
      variantsPath: (yield* LibraryStore).variantsPath,
    });
    if (plan.subject_kind === "collection")
      yield* markAuthorWorkspaceRemoved(state, plan.subject_id);
    return { kind: "removed" as const, value: { ...plan, uninstalled: removed.uninstalled } };
  },
  (effect, _state, options) => (options.dryRun ? effect : withLibraryWriter(effect)),
);
