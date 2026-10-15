import { ProjectionWouldDuplicate } from "../projection/harness-shadows.js";
import {
  readLibrarySkillMetadata,
  sourceIdentityLabel,
  type SkillMetadata,
} from "./skill-metadata.js";
import {
  bindingSkillIds,
  currentSkillVersion,
  retainedTreePath,
  versionBacking,
  LibraryStore,
  type LibraryState,
  type SourceIdentity,
  type SkitBindingScope as Scope,
} from "@smolai/skit-core";
import { Effect, FileSystem, Result } from "effect";
import { join } from "node:path";
import {
  LibrarySubjectNotFound,
  resolveLibrarySubject,
} from "../workflows/library/subject-resolution.js";
import type { InvocationOption } from "../invocation/policy.js";
import { invocationReadModel, type InvocationReadModel } from "../invocation/read-model.js";
import { bindingRowLabel, destinationLabel, scopeKey } from "./read-model.js";
import { classifyFailure, type ClassifiedFailure } from "../failure-classification.js";
import { unspecifiedDeclaredInvocation } from "../invocation/library-source.js";
import type { ProjectionOptions } from "../workflows/library/projection-options.js";
import {
  applyBindingChanges,
  previewBindingChanges,
  type BindingChangeRequest,
  type BindingChangePlan,
} from "./binding-changes.js";

export interface LibraryBindingRow {
  readonly scope: Scope;
  readonly invocation: InvocationOption;
  readonly policy?: InvocationReadModel;
  readonly label: string;
}

export interface LibrarySkillRow extends SkillMetadata {
  readonly name: string;
  readonly skillVersionId: string;
  readonly collectionId: string;
  readonly heading: string;
  readonly hasCollection?: boolean;
  readonly collectionSource?: { readonly kind: SourceIdentity["kind"]; readonly locator: string };
  readonly bindings: readonly LibraryBindingRow[];
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
  readonly plan: BindingChangePlan;
  readonly facts: readonly PreviewFacts[];
  readonly policies: readonly InvocationReadModel[];
}

export type LibraryActionOutcome =
  | { readonly kind: "preview"; readonly pending: PendingLibraryChange }
  | { readonly kind: "applied"; readonly pending: PendingLibraryChange }
  | { readonly kind: "unchanged"; readonly pending: PendingLibraryChange }
  | { readonly kind: "cancelled"; readonly pending?: PendingLibraryChange }
  | { readonly kind: "failed"; readonly failure: ClassifiedFailure };

export interface LibrarySessionState {
  readonly skills: readonly LibrarySkillRow[];
  readonly pending?: PendingLibraryChange;
  readonly outcome?: LibraryActionOutcome;
}

const bindingRows = (
  state: LibraryState,
  skillId: LibraryState["skills"][number]["skill_id"],
  skillName: string,
): LibraryBindingRow[] =>
  [...state.global_bindings, ...state.local_bindings]
    .filter((binding) => bindingSkillIds(state, binding).includes(skillId))
    .map((binding) => {
      const invocation = (binding.invocation_policies?.[skillId] ?? "declared") as InvocationOption;
      const policy = invocationReadModel({
        skill: skillName,
        author: unspecifiedDeclaredInvocation(),
        storedIntent: invocation,
      });
      return {
        scope: binding.scope,
        invocation,
        policy,
        label: bindingRowLabel({ scope: binding.scope, policy }),
      };
    });

const skillRows = (
  state: LibraryState,
  metadata: ReadonlyMap<string, SkillMetadata>,
): LibrarySkillRow[] =>
  state.skills.flatMap((skill) => {
    const collection = state.collections.find(
      (candidate) => candidate.collection_id === skill.collection_id,
    );
    const heading = collection?.label ?? skill.name;
    const collectionSource =
      collection?.upstream?.source_identity ??
      state.acquisitions.find((acquisition) => acquisition.collection_id === skill.collection_id)
        ?.source_identity;
    const version = currentSkillVersion(state, skill);
    if (version === undefined) return [];
    return [
      {
        ...metadata.get(skill.skill_id)!,
        name: skill.name,
        skillVersionId: version.skill_version_id,
        collectionId: collection?.collection_id ?? skill.skill_id,
        heading,
        hasCollection: collection !== undefined,
        ...(collectionSource === undefined
          ? {}
          : {
              collectionSource: {
                kind: collectionSource.kind,
                locator: sourceIdentityLabel(collectionSource),
              },
            }),
        bindings: bindingRows(state, skill.skill_id, skill.name),
      },
    ];
  });

export const openLibrarySession = Effect.fn("LibrarySession.open")(function* () {
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const metadata = yield* readLibrarySkillMetadata(state, store.originalsPath);
  return { skills: skillRows(state, metadata) } satisfies LibrarySessionState;
});

/** Read the exact retained version selected by the front end, never a native Projection. */
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
      retainedTreePath(store.originalsPath, backing.copy.digest),
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
): InvocationReadModel {
  return invocationReadModel({
    skill: row.name,
    author: unspecifiedDeclaredInvocation(),
    storedIntent: intent,
  });
}

const factFromPlan = (plan: BindingChangePlan["changes"][number]): PreviewFacts => ({
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
  configuration: ProjectionOptions,
  operations: readonly BindingChangeRequest[],
  policies: readonly InvocationReadModel[] = [],
) {
  const attempted = yield* Effect.result(
    previewBindingChanges(operations, configuration).pipe(
      Effect.tap((plan) =>
        Effect.forEach(plan.changes, (change) =>
          change.shadows?.length
            ? Effect.fail(new ProjectionWouldDuplicate({ shadows: change.shadows }))
            : Effect.void,
        ),
      ),
    ),
  );
  if (Result.isFailure(attempted))
    return {
      ...state,
      pending: undefined,
      outcome: { kind: "failed", failure: classifyFailure(attempted.failure) },
    } satisfies LibrarySessionState & { readonly outcome: LibraryActionOutcome };
  const pending: PendingLibraryChange = {
    plan: attempted.success,
    facts: attempted.success.changes.map((plan, index) => ({
      ...factFromPlan(plan),
      ...(plan.repair
        ? {
            writes: plan.enabled
              ? ("copies checked for repair" as const)
              : ("projection removed" as const),
          }
        : {}),
      ...(operations[index]?.all
        ? {
            wholeCollection: true,
            collectionLabel:
              state.skills.find((row) => row.collectionId === plan.subject_id)?.heading ??
              plan.subject_id,
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
  configuration: ProjectionOptions,
  row: LibrarySkillRow,
  selection: {
    readonly scope: Scope;
    readonly invocation?: InvocationOption;
  },
) {
  return proposeLibraryChange(
    state,
    configuration,
    [
      {
        query: row.skillVersionId,
        scope: selection.scope,
        enabled: true,
        ...(selection.invocation === undefined ? {} : { invocation: selection.invocation }),
      },
    ],
    [libraryPolicyAfter(row, selection.invocation ?? "declared")],
  );
}

export function proposeLibraryDisable(
  state: LibrarySessionState,
  configuration: ProjectionOptions,
  row: LibrarySkillRow,
  bindings: readonly LibraryBindingRow[],
) {
  const byScope = new Map(bindings.map((binding) => [scopeKey(binding.scope), binding.scope]));
  return proposeLibraryChange(
    state,
    configuration,
    [...byScope.values()].map((scope) => ({ query: row.skillVersionId, scope, enabled: false })),
  );
}

export function libraryCollectionScopes(state: LibrarySessionState, collectionId: string): Scope[] {
  return [
    ...new Map(
      state.skills
        .filter((row) => row.collectionId === collectionId)
        .flatMap((row) => row.bindings)
        .map((binding) => [scopeKey(binding.scope), binding.scope]),
    ).values(),
  ];
}

/** Whole-Collection intent follows future Source membership changes. */
export function proposeLibraryCollectionChange(
  state: LibrarySessionState,
  configuration: ProjectionOptions,
  collectionId: string,
  enabled: boolean,
  scopes: readonly Scope[],
) {
  const uniqueScopes = new Map(scopes.map((scope) => [scopeKey(scope), scope]));
  return proposeLibraryChange(
    state,
    configuration,
    [...uniqueScopes.values()].map((scope) => ({
      query: collectionId,
      all: true,
      scope,
      enabled,
    })),
  );
}

export function proposeLibraryInvocation(
  state: LibrarySessionState,
  configuration: ProjectionOptions,
  row: LibrarySkillRow,
  binding: LibraryBindingRow,
  invocation: InvocationOption,
) {
  return proposeLibraryChange(
    state,
    configuration,
    [
      {
        query: row.skillVersionId,
        scope: binding.scope,
        enabled: true,
        invocation,
      },
    ],
    [libraryPolicyAfter(row, invocation)],
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
  const applied = yield* Effect.result(applyBindingChanges(pending.plan));
  const refreshed = yield* openLibrarySession();
  const outcome: LibraryActionOutcome = Result.isSuccess(applied)
    ? { kind: "applied", pending }
    : { kind: "failed", failure: classifyFailure(applied.failure) };
  return { ...refreshed, outcome };
});
