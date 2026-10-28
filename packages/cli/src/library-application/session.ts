import { InstalledSkillWouldDuplicate } from "../projection/duplicates.js";
import type { SkillMetadata } from "./skill-metadata.js";
import {
  collectionVersionPath,
  versionBacking,
  LibraryStore,
  ImportContentInvalid,
  type SourceIdentity,
  type InstallScope as Scope,
} from "@smolai/skit-core";
import { Effect, FileSystem, Result } from "effect";
import { join } from "node:path";
import {
  LibrarySubjectNotFound,
  resolveLibrarySubject,
} from "../workflows/library/subject-resolution.js";
import type { InvocationOption } from "../invocation/policy.js";
import { invocationReadModel, type InvocationReadModel } from "../invocation/read-model.js";
import type { AuthorInvocationRead } from "../invocation/library-source.js";
import { scopeRowLabel, destinationLabel } from "./read-model.js";
import { classifyFailure, type ClassifiedFailure } from "../failure-classification.js";
import type { InstalledSkillOptions } from "../workflows/library/installed-skill-options.js";
import {
  applySetEnabledPlan,
  openSetEnabledSession,
  SetEnabledStale,
  type SetEnabledIntent,
  type SetEnabledSession,
  type SetEnabledPlan,
} from "./set-enabled.js";

export interface ScopeRow {
  readonly scope: Scope;
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
  readonly collectionSource?: { readonly kind: SourceIdentity["kind"]; readonly locator: string };
  readonly scopes: readonly ScopeRow[];
}

export interface PreviewFacts {
  readonly action: "enable" | "disable";
  readonly skills: readonly string[];
  readonly scope: Scope;
  readonly destination: string;
  readonly invocation?: InvocationOption;
  readonly writes:
    | "projection created"
    | "projection removed"
    | "nothing to change"
    | "copies checked for repair";
  readonly wholeCollection?: boolean;
  readonly collectionLabel?: string;
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
  | { readonly kind: "failed"; readonly failure: ClassifiedFailure };

const sessionSelection = Symbol("LibrarySessionSelection");

export interface LibrarySessionState {
  readonly [sessionSelection]?: SetEnabledSession;
  readonly skills: readonly LibrarySkillRow[];
  readonly pending?: PendingLibraryChange;
  readonly outcome?: LibraryActionOutcome;
}

export const openLibrarySession = Effect.fn("LibrarySession.open")(function* () {
  const selection = yield* openSetEnabledSession();
  const rows = yield* selection.view.readSkills();
  const skills: LibrarySkillRow[] = rows.map((row) => ({
    source: row.source,
    revision: row.revision,
    source_updated_at: row.source_updated_at,
    acquired_at: row.acquired_at,
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
          label: `${destinationLabel(scope)} · Author preference unavailable`,
        };
      const policy = invocationReadModel({
        skill: row.name,
        author: row.authorInvocation.success,
        storedIntent: invocation,
      });
      return { scope, invocation, policy, label: scopeRowLabel({ scope, policy }) };
    }),
  }));
  return { skills, [sessionSelection]: selection } satisfies LibrarySessionState;
});

/** Read the exact retained version selected by the front end, never a native installed skill. */
export const readLibrarySkillContent = Effect.fn("LibrarySession.readSkillContent")(function* (
  skillVersionId: string,
) {
  const store = yield* LibraryStore;
  const state = yield* store.load;
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
      collectionVersionPath(store.originalsPath, backing.copy.digest),
      backing.member.source_path,
      "SKILL.md",
    ),
  );
});

export const refreshLibrarySession = Effect.fn("LibrarySession.refresh")(function* (
  state: LibrarySessionState,
) {
  return {
    ...(yield* openLibrarySession()),
    ...(state.outcome === undefined ? {} : { outcome: state.outcome }),
  } satisfies LibrarySessionState;
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
      failure: classifyFailure(new ImportContentInvalid({ diagnostics: [reason] })),
    },
  }) satisfies LibrarySessionState & { readonly outcome: LibraryActionOutcome };

const factFromPlan = (plan: SetEnabledPlan["changes"][number]): PreviewFacts => ({
  action: plan.enabled ? "enable" : "disable",
  skills: plan.skills,
  scope: plan.scope,
  destination: destinationLabel(plan.scope),
  ...(plan.invocation === undefined ? {} : { invocation: plan.invocation }),
  writes: !plan.changed
    ? "nothing to change"
    : plan.enabled
      ? "projection created"
      : "projection removed",
});

const proposeLibraryChange = Effect.fn("LibrarySession.propose")(function* (
  state: LibrarySessionState,
  configuration: InstalledSkillOptions,
  intent: SetEnabledIntent,
  policies: readonly InvocationReadModel[] = [],
) {
  const selection = state[sessionSelection];
  const attempted = yield* Effect.result(
    Effect.gen(function* () {
      if (selection === undefined)
        return yield* new SetEnabledStale({
          message: "Open the Library before proposing a Binding change",
        });
      const plan = yield* selection.plan(intent, configuration);
      for (const change of plan.changes)
        if (change.shadows?.length)
          return yield* new InstalledSkillWouldDuplicate({ duplicates: change.shadows });
      return plan;
    }),
  );
  if (Result.isFailure(attempted))
    return {
      ...state,
      pending: undefined,
      outcome: { kind: "failed", failure: classifyFailure(attempted.failure) },
    } satisfies LibrarySessionState & { readonly outcome: LibraryActionOutcome };
  const pending: PendingLibraryChange = {
    plan: attempted.success,
    facts: attempted.success.changes.map((plan) => ({
      ...factFromPlan(plan),
      ...(plan.repair
        ? {
            writes: plan.enabled
              ? ("copies checked for repair" as const)
              : ("projection removed" as const),
          }
        : {}),
      ...(intent.members === "whole"
        ? {
            wholeCollection: true,
            collectionLabel:
              selection?.view.collections.find((collection) => collection.id === plan.subject_id)
                ?.label ?? plan.subject_id,
          }
        : {}),
    })),
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
  configuration: InstalledSkillOptions,
  row: LibrarySkillRow,
  selection: { readonly scope: Scope; readonly invocation?: InvocationOption },
) {
  const policy = libraryPolicyAfter(row, selection.invocation ?? "declared");
  if (Result.isFailure(policy) && selection.invocation !== undefined)
    return Effect.succeed(unavailablePolicyChange(state, policy.failure));
  return proposeLibraryChange(
    state,
    configuration,
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
  configuration: InstalledSkillOptions,
  row: LibrarySkillRow,
  scopes: readonly ScopeRow[],
) {
  return proposeLibraryChange(state, configuration, {
    subject: row.skillId,
    where: scopes.map((scopeRow) => scopeRow.scope),
    enabled: false,
  });
}

export function libraryCollectionScopes(state: LibrarySessionState, collectionId: string): Scope[] {
  return state[sessionSelection]?.view.scopesFor(collectionId) ?? [];
}

/** Whole-Collection intent follows future Source membership changes. */
export function proposeLibraryCollectionChange(
  state: LibrarySessionState,
  configuration: InstalledSkillOptions,
  collectionId: string,
  enabled: boolean,
  scopes: readonly Scope[],
) {
  return proposeLibraryChange(state, configuration, {
    subject: collectionId,
    members: "whole",
    where: scopes,
    enabled,
  });
}

export function proposeLibraryInvocation(
  state: LibrarySessionState,
  configuration: InstalledSkillOptions,
  row: LibrarySkillRow,
  scopeRow: ScopeRow,
  invocation: InvocationOption,
) {
  const policy = libraryPolicyAfter(row, invocation);
  if (Result.isFailure(policy))
    return Effect.succeed(unavailablePolicyChange(state, policy.failure));
  return proposeLibraryChange(
    state,
    configuration,
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
  const applied = yield* Effect.result(applySetEnabledPlan(pending.plan));
  const refreshed = yield* openLibrarySession();
  const outcome: LibraryActionOutcome = Result.isSuccess(applied)
    ? { kind: "applied", pending }
    : { kind: "failed", failure: classifyFailure(applied.failure) };
  return { ...refreshed, outcome };
});
