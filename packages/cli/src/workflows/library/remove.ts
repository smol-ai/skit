import { recordedLibrary } from "../../library-application/library-owner.js";
import { AuthorWorkspace } from "../../author/workspace.js";
import {
  enabledSkillIds,
  SkillRemovalRequiresCollection,
  CollectionRemovalMissing,
  type LibraryState,
} from "@smolai/skit-core";
import { Effect, Option } from "effect";
import { resolveLibrarySubject } from "@smolai/skit-core";

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

export const executeRemove = Effect.fn("Library.executeRemove")(function* (
  state: LibraryState,
  options: RemoveOptions,
) {
  const plan = yield* planRemove(state, options.query);
  if (options.dryRun) return { kind: "plan" as const, value: plan };
  // Planning only admits a Skill that is its Collection's only Skill, so removal is of a Collection.
  // Library removes exactly what was planned, and refuses if the Library has since moved on.
  const collectionId =
    plan.subject_kind === "collection"
      ? state.collections.find((item) => item.collection_id === plan.subject_id)?.collection_id
      : state.skills.find((skill) => skill.skill_id === plan.subject_id)?.collection_id;
  if (collectionId === undefined)
    return yield* new CollectionRemovalMissing({ collection_id: plan.subject_id });
  const library = yield* recordedLibrary(state);
  const remove = Effect.flatMap(
    library.plan({ _tag: "Remove", collectionId }, { base: state }),
    library.apply,
  );
  // An authored Collection's workspace records the removal before the Library applies it, and
  // completes it after, under the workspace lease (A15). Only a workspace that still carries the
  // Collection's identity is marked; if its folder is gone, the Library removal runs alone.
  const collection = state.collections.find((item) => item.collection_id === collectionId);
  const workspaceId =
    plan.subject_kind === "collection" &&
    collection?.upstream?.source_identity.kind === "authored-workspace"
      ? collection.upstream.source_identity.workspace_id
      : undefined;
  const workspacePath =
    workspaceId === undefined
      ? undefined
      : state.imports.find(
          (sourceImport) =>
            sourceImport.collection_id === collectionId &&
            sourceImport.source_identity.kind === "authored-workspace",
        )?.input.value;
  const workspaces = yield* AuthorWorkspace;
  const root =
    workspacePath === undefined
      ? Option.none()
      : yield* workspaces.resolveRoot(workspacePath).pipe(
          Effect.map(Option.some),
          Effect.catchTag("AuthorWorkspaceRootInvalid", () => Effect.succeedNone),
        );
  const outcome = Option.isNone(root)
    ? yield* remove
    : yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* workspaces.acquire(root.value);
          const identity = yield* workspaces.readIdentity(root.value);
          if (Option.isNone(identity) || identity.value.workspaceId !== workspaceId)
            return yield* remove;
          const { registration } = identity.value;
          const removing =
            registration === "IdentityOnly" || registration === "Registered"
              ? yield* lease.register({ from: { ...identity.value, registration }, to: "Removing" })
              : identity.value;
          const removed = yield* remove;
          if (removing.registration === "Removing")
            yield* lease.register({
              from: { ...removing, registration: "Removing" },
              to: "Removed",
            });
          return removed;
        }),
      );
  const uninstalled =
    outcome._tag === "Applied"
      ? outcome.copies.filter((copy) => copy._tag === "Uninstalled").length
      : 0;
  return { kind: "removed" as const, value: { ...plan, uninstalled } };
});
