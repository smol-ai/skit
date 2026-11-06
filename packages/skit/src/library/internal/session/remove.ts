import { Effect } from "effect";
import * as Library from "../../library.js";
import { emptyLibraryState, type LibraryState } from "../../library-state.js";
import { resolveLibrarySubject } from "../../subject-resolution.js";
import { enabledSkillIds } from "../../library-contracts.js";
import {
  SkillRemovalRequiresCollection,
  CollectionRemovalMissing,
} from "../../installation/remove.js";

export const removalSummary = Effect.fn("Library.planRemove")(function* (
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

/** Capture the Library displayed; apply refuses if it changed since. */
const openRemoveSession = Effect.fn("Library.openRemoveSession")(function* (query: string) {
  const library = yield* Library.Service;
  const snapshot = yield* library.read;
  const state = snapshot._tag === "Present" ? snapshot.state : emptyLibraryState();
  const summary = yield* removalSummary(state, query);
  const collectionId =
    summary.subject_kind === "collection"
      ? state.collections.find((item) => item.collection_id === summary.subject_id)?.collection_id
      : state.skills.find((skill) => skill.skill_id === summary.subject_id)?.collection_id;
  if (collectionId === undefined)
    return yield* new CollectionRemovalMissing({ collection_id: summary.subject_id });
  return {
    summary: structuredClone(summary),
    apply: Effect.fn("Library.removeSelection")(function* () {
      const outcome = (yield* library.apply({
        _tag: "Apply",
        plan: yield* library.plan({ _tag: "Remove", collectionId }, { base: snapshot }),
      })).result;
      const uninstalled =
        outcome._tag === "Applied"
          ? outcome.copies.filter((copy) => copy._tag === "Uninstalled").length
          : 0;
      return { ...summary, uninstalled };
    }),
  };
});

export interface RemoveOptions {
  readonly query: string;
  readonly dryRun: boolean;
}

/** Remove a Collection, or the sole Skill's Collection, and uninstall the Skills it installed. */
export const removeCollection = Effect.fn("Library.removeCollection")(function* (
  options: RemoveOptions,
) {
  const selection = yield* openRemoveSession(options.query);
  if (options.dryRun) return { kind: "plan" as const, value: selection.summary };
  return { kind: "removed" as const, value: yield* selection.apply() };
});
