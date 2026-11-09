import type * as Library from "../../library.js";
import { uniqueInstallScopes } from "./set-enabled-request.js";
import { StalePlan } from "../../library-plan.js";
import { emptyLibraryState } from "../../library-state.js";
import { InstalledSkillWouldDuplicate } from "../../library-plan.js";
import type { SkillMetadata } from "./skill-metadata.js";
import { collectionVersionPath } from "../../collection-version.js";
import { versionBacking } from "../../library-contracts.js";
import { ImportContentInvalid } from "../../failures.js";
import { type InstallScope } from "../../scope.js";
import { Effect, FileSystem, Result } from "effect";
import { join } from "node:path";
import { LibrarySubjectNotFound, resolveLibrarySubject } from "../../subject-resolution.js";
import type { InvocationOption } from "./invocation-option.js";
import { invocationReadModel, type InvocationReadModel } from "./invocation.js";
import type { AuthorInvocationRead } from "./invocation-source.js";
import type { CollectionSource } from "../../collection-source.js";
import { scopeRowLabel, destinationLabel } from "./read-model.js";
import { failureDetails, type FailureDetails } from "../../../shared/failure.js";
import { setEnabledOutcomes, type SetEnabledIntent, type SetEnabledPlan } from "./set-enabled.js";

export interface ScopeRow {
  readonly scope: InstallScope;
  readonly invocation: InvocationOption;
  readonly policy?: InvocationReadModel;
  readonly label: string;
}

export interface LibrarySkillRow extends SkillMetadata {
  readonly name: string;
  readonly skillId: string;
  readonly skillVersionId: string;
  readonly authorInvocation: AuthorInvocationRead;
  readonly invocationWarning?: string;
  readonly collectionId: string;
  readonly heading: string;
  readonly hasCollection?: boolean;
  readonly collectionSource?: CollectionSource;
  readonly scopes: readonly ScopeRow[];
}

interface PreviewFacts {
  readonly action: "enable" | "disable";
  readonly skills: readonly string[];
  readonly scope: InstallScope;
  readonly destination: string;
  readonly invocation?: InvocationOption;
  readonly writes:
    | "install skill files"
    | "remove installed skill files"
    | "nothing to change"
    | "copies checked for repair";
  readonly wholeCollection?: boolean;
  readonly collectionLabel?: string;
  readonly collectionSource?: CollectionSource;
}

export interface PendingLibraryChange {
  readonly plan: SetEnabledPlan;
  readonly facts: readonly PreviewFacts[];
  readonly policies: readonly InvocationReadModel[];
}

export type LibraryActionOutcome =
  | { readonly kind: "preview"; readonly pending: PendingLibraryChange }
  | { readonly kind: "applied"; readonly pending: PendingLibraryChange }
  | { readonly kind: "unchanged"; readonly pending: PendingLibraryChange }
  | { readonly kind: "cancelled"; readonly pending?: PendingLibraryChange }
  | { readonly kind: "failed"; readonly failure: FailureDetails };

const sessionContext = Symbol("LibrarySessionContext");
type SessionLibrary = Pick<Library.Interface, "read" | "skills" | "list" | "planEnabled" | "apply">;
interface SessionContext {
  readonly library: SessionLibrary;
  readonly base: Library.Snapshot;
  readonly collections: Effect.Success<ReturnType<Library.Interface["list"]>>["collections"];
  readonly placements: Effect.Success<ReturnType<Library.Interface["list"]>>["placements"];
}

export interface LibrarySessionState {
  readonly [sessionContext]?: SessionContext;
  readonly skills: readonly LibrarySkillRow[];
  readonly pending?: PendingLibraryChange;
  readonly outcome?: LibraryActionOutcome;
}

export const openLibrarySession = Effect.fn("LibrarySession.open")(function* (
  library: SessionLibrary,
) {
  return yield* sessionFromSnapshot(library, yield* library.read);
});

const sessionFromSnapshot = Effect.fn("LibrarySession.read")(function* (
  library: SessionLibrary,
  base: Library.Snapshot,
) {
  const rows = yield* library.skills({ base });
  const { collections, placements } = yield* library.list({ base });
  const skills: LibrarySkillRow[] = rows.map((row) => ({
    source: row.source,
    revision: row.revision,
    source_updated_at: row.source_updated_at,
    imported_at: row.imported_at,
    ...(row.saved_at === undefined ? {} : { saved_at: row.saved_at }),
    name: row.name,
    skillId: row.id,
    skillVersionId: row.versionId,
    authorInvocation: row.authorInvocation,
    ...(Result.isFailure(row.authorInvocation)
      ? { invocationWarning: `Author preference unavailable: ${row.authorInvocation.failure}` }
      : {}),
    collectionId: row.collectionId,
    heading: row.collectionLabel ?? row.name,
    hasCollection: row.collectionLabel !== undefined,
    ...(row.collectionSource === undefined ? {} : { collectionSource: row.collectionSource }),
    scopes: row.scopes.map(({ scope, invocation }) => {
      if (Result.isFailure(row.authorInvocation))
        return {
          scope,
          invocation,
          label: `${destinationLabel(scope)} | Author preference unavailable`,
        };
      const policy = invocationReadModel({
        skill: row.name,
        author: row.authorInvocation.success,
        storedIntent: invocation,
      });
      return { scope, invocation, policy, label: scopeRowLabel({ scope, policy }) };
    }),
  }));
  const session: LibrarySessionState = {
    skills,
    [sessionContext]: { library, base, collections, placements },
  };
  return session;
});

/** Read the exact retained version selected by the front end, never a native installed skill. */
export const readLibrarySkillContent = Effect.fn("LibrarySession.readSkillContent")(function* (
  read: Library.Interface["read"],
  home: string,
  skillVersionId: string,
) {
  const snapshot = yield* read;
  const state = snapshot._tag === "Present" ? snapshot.state : emptyLibraryState();
  const subject = yield* resolveLibrarySubject(state, skillVersionId);
  if (subject.kind !== "skill") return yield* new LibrarySubjectNotFound({ query: skillVersionId });
  const version = subject.skill.versions.find(
    (candidate) => candidate.skill_version_id === skillVersionId,
  );
  const backing = version === undefined ? undefined : versionBacking(state, subject.skill, version);
  if (!backing) return yield* new LibrarySubjectNotFound({ query: skillVersionId });
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(
    join(
      collectionVersionPath(join(home, "originals"), backing.copy.hash),
      backing.member.source_path,
      "SKILL.md",
    ),
  );
});

export function libraryPolicyAfter(
  row: LibrarySkillRow,
  intent: InvocationOption,
): Result.Result<InvocationReadModel, string> {
  return Result.map(row.authorInvocation, (author) =>
    invocationReadModel({
      skill: row.name,
      author,
      storedIntent: intent,
    }),
  );
}

const unavailablePolicyChange = (
  state: LibrarySessionState,
  reason: string,
): Effect.Success<ReturnType<typeof proposeLibraryChange>> =>
  ({
    ...state,
    pending: undefined,
    outcome: {
      kind: "failed",
      failure: failureDetails(new ImportContentInvalid({ diagnostics: [reason] })),
    },
  }) satisfies LibrarySessionState & { readonly outcome: LibraryActionOutcome };

const factFromPlan = (plan: SetEnabledPlan["changes"][number]): PreviewFacts => ({
  action: plan.action,
  skills: plan.skills,
  scope: plan.scope,
  destination: destinationLabel(plan.scope),
  ...(plan.invocation === undefined ? {} : { invocation: plan.invocation }),
  writes: !plan.changed
    ? "nothing to change"
    : plan.action === "enable"
      ? "install skill files"
      : "remove installed skill files",
});

const proposeLibraryChange = Effect.fn("LibrarySession.propose")(function* (
  state: LibrarySessionState,
  intent: SetEnabledIntent,
  policies: readonly InvocationReadModel[] = [],
) {
  const context = state[sessionContext];
  const attempted = yield* Effect.result(
    Effect.gen(function* () {
      if (context === undefined)
        return yield* new StalePlan({
          message: "Open the Library before proposing a Binding change",
        });
      const plan = yield* context.library.planEnabled([intent], { base: context.base });
      for (const change of plan.changes)
        if (change.duplicates?.length)
          return yield* new InstalledSkillWouldDuplicate({ duplicates: change.duplicates });
      return plan;
    }),
  );
  if (Result.isFailure(attempted))
    return {
      ...state,
      pending: undefined,
      outcome: { kind: "failed", failure: failureDetails(attempted.failure) },
    } satisfies LibrarySessionState & { readonly outcome: LibraryActionOutcome };
  const pending: PendingLibraryChange = {
    plan: attempted.success,
    facts: attempted.success.changes.map((plan) => {
      const collection = context?.collections.find(
        (item) =>
          item.id === plan.subject_id ||
          item.members.some((member) => member.id === plan.subject_id),
      );
      return {
        ...factFromPlan(plan),
        ...(collection === undefined
          ? {}
          : { collectionLabel: collection.label, collectionSource: collection.collectionSource }),
        ...(plan.repair
          ? {
              writes:
                plan.action === "enable"
                  ? ("copies checked for repair" as const)
                  : ("remove installed skill files" as const),
            }
          : {}),
        ...(intent.members === "whole"
          ? {
              wholeCollection: true,
              collectionLabel:
                context?.collections.find((collection) => collection.id === plan.subject_id)
                  ?.label ?? plan.subject_id,
            }
          : {}),
      };
    }),
    policies,
  };
  if (attempted.success.changes.every((plan) => !plan.changed && !plan.repair))
    return {
      ...state,
      pending: undefined,
      outcome: { kind: "unchanged", pending },
    } satisfies LibrarySessionState & { readonly outcome: LibraryActionOutcome };
  return {
    ...state,
    pending,
    outcome: { kind: "preview", pending },
  } satisfies LibrarySessionState & { readonly outcome: LibraryActionOutcome };
});

export function proposeLibraryEnable(
  state: LibrarySessionState,
  row: LibrarySkillRow,
  selection: { readonly scope: InstallScope; readonly invocation?: InvocationOption },
) {
  const policy = libraryPolicyAfter(row, selection.invocation ?? "declared");
  if (Result.isFailure(policy) && selection.invocation !== undefined)
    return Effect.succeed(unavailablePolicyChange(state, policy.failure));
  return proposeLibraryChange(
    state,
    {
      subject: row.skillId,
      where: [selection.scope],
      enabled: true,
      invocation: selection.invocation,
    },
    Result.isSuccess(policy) ? [policy.success] : [],
  );
}

export function proposeLibraryDisable(
  state: LibrarySessionState,
  row: LibrarySkillRow,
  scopes: readonly ScopeRow[],
) {
  return proposeLibraryChange(state, {
    subject: row.skillId,
    where: scopes.map((scopeRow) => scopeRow.scope),
    enabled: false,
  });
}

export function libraryCollectionScopes(
  state: LibrarySessionState,
  collectionId: string,
): InstallScope[] {
  const placements = state[sessionContext]?.placements ?? [];
  return uniqueInstallScopes(
    placements.filter((item) => item.collectionId === collectionId).map((item) => item.scope),
  );
}

/** Whole-Collection intent follows future Source membership changes. */
export function proposeLibraryCollectionChange(
  state: LibrarySessionState,
  collectionId: string,
  enabled: boolean,
  scopes: readonly InstallScope[],
) {
  return proposeLibraryChange(state, {
    subject: collectionId,
    members: "whole",
    where: scopes,
    enabled,
  });
}

export function proposeLibraryInvocation(
  state: LibrarySessionState,
  row: LibrarySkillRow,
  scopeRow: ScopeRow,
  invocation: InvocationOption,
) {
  const policy = libraryPolicyAfter(row, invocation);
  if (Result.isFailure(policy))
    return Effect.succeed(unavailablePolicyChange(state, policy.failure));
  return proposeLibraryChange(
    state,
    {
      subject: row.skillId,
      where: [scopeRow.scope],
      enabled: true,
      invocation,
    },
    [policy.success],
  );
}

export function cancelLibraryChange(
  state: LibrarySessionState,
): LibrarySessionState & { readonly outcome: LibraryActionOutcome } {
  return {
    ...state,
    pending: undefined,
    outcome: {
      kind: "cancelled",
      ...(state.pending === undefined ? {} : { pending: state.pending }),
    },
  };
}

export const confirmLibraryChange = Effect.fn("LibrarySession.confirm")(function* (
  state: LibrarySessionState,
) {
  const pending = state.pending;
  if (pending === undefined)
    return state.outcome?.kind === "unchanged" ? state : cancelLibraryChange(state);
  const context = state[sessionContext];
  if (context === undefined)
    return yield* new StalePlan({ message: "Open the Library before confirming a change" });
  const applied = yield* Effect.result(
    Effect.gen(function* () {
      return yield* setEnabledOutcomes(
        (yield* context.library.apply({ _tag: "Apply", plan: pending.plan.plan })).result,
      );
    }),
  );
  const refreshed = yield* sessionFromSnapshot(context.library, yield* context.library.read);
  const outcome: LibraryActionOutcome = Result.isSuccess(applied)
    ? { kind: "applied", pending }
    : { kind: "failed", failure: failureDetails(applied.failure) };
  return { ...refreshed, outcome };
});
