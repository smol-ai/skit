import { ProjectionWouldDuplicate } from "../../projection/harness-shadows.js";
import { readLibrarySkillMetadata, type SkillMetadata } from "./skill-metadata.js";
import {
  bindingSkillIds,
  currentSkillVersion,
  LibraryStore,
  withLibraryWriter,
  type LibraryState,
  type SkitBindingScope as Scope,
} from "@smolai/skit-core";
import { Effect, Result } from "effect";
import type { InvocationOption } from "../../invocation/policy.js";
import { invocationReadModel, type InvocationReadModel } from "../../invocation/read-model.js";
import { bindingRowLabel, destinationLabel, scopeKey } from "../../library/read-model.js";
import { classifyFailure, type ClassifiedFailure } from "../../failure-classification.js";
import { unspecifiedDeclaredInvocation } from "../../invocation/library-source.js";
import type { ProjectionOptions } from "./projection-options.js";
import {
  applyLibraryBindings,
  libraryStateRevision,
  SetEnabledStale,
  previewLibraryBindings,
} from "./set-enabled.js";
import type { SetEnabledInvocation } from "./set-enabled-invocation.js";

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
  readonly bindings: readonly LibraryBindingRow[];
}

export interface PreviewFacts {
  readonly action: "enable" | "disable";
  readonly skills: readonly string[];
  readonly scope: Scope;
  readonly destination: string;
  readonly invocation?: InvocationOption;
  readonly writes: "projection created" | "projection removed";
  readonly wholeCollection?: boolean;
}

interface PendingOperation {
  readonly all?: boolean;
  readonly query: string;
  readonly invocation: SetEnabledInvocation;
}

export interface PendingLibraryChange {
  readonly operations: readonly PendingOperation[];
  readonly facts: readonly PreviewFacts[];
  readonly policies: readonly InvocationReadModel[];
  readonly libraryRevision: string;
}

export type LibraryActionOutcome =
  | { readonly kind: "preview"; readonly pending: PendingLibraryChange }
  | { readonly kind: "applied"; readonly pending: PendingLibraryChange }
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
    const version = currentSkillVersion(state, skill);
    if (version === undefined) return [];
    return [
      {
        ...metadata.get(skill.skill_id)!,
        name: skill.name,
        skillVersionId: version.skill_version_id,
        collectionId: collection?.collection_id ?? skill.skill_id,
        heading,
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

const factFromPlan = (
  plan: Effect.Success<ReturnType<typeof previewLibraryBindings>>,
): PreviewFacts => ({
  action: plan.enabled ? "enable" : "disable",
  skills: plan.skills,
  scope: plan.scope,
  destination: destinationLabel(plan.scope),
  ...(plan.invocation === undefined ? {} : { invocation: plan.invocation }),
  writes: plan.enabled ? "projection created" : "projection removed",
});

const proposeLibraryChange = Effect.fn("LibrarySession.propose")(function* (
  state: LibrarySessionState,
  configuration: ProjectionOptions,
  operations: readonly PendingOperation[],
  policies: readonly InvocationReadModel[] = [],
) {
  const attempted = yield* Effect.result(
    Effect.gen(function* () {
      const current = yield* (yield* LibraryStore).load;
      return {
        libraryRevision: libraryStateRevision(current),
        plans: yield* Effect.forEach(operations, ({ query, invocation, all }) =>
          Effect.gen(function* () {
            const plan = yield* previewLibraryBindings(current, {
              query,
              all: all ?? false,
              invocation,
              roots: configuration,
              variantsPath: configuration.variantsPath,
            });
            if (plan.shadows?.length)
              return yield* new ProjectionWouldDuplicate({ shadows: plan.shadows });
            return plan;
          }),
        ),
      };
    }),
  );
  if (Result.isFailure(attempted))
    return {
      ...state,
      pending: undefined,
      outcome: { kind: "failed", failure: classifyFailure(attempted.failure) },
    } satisfies LibrarySessionState & { readonly outcome: LibraryActionOutcome };
  const pending: PendingLibraryChange = {
    operations,
    facts: attempted.success.plans.map((plan, index) => ({
      ...factFromPlan(plan),
      ...(operations[index]?.all ? { wholeCollection: true } : {}),
    })),
    policies,
    libraryRevision: attempted.success.libraryRevision,
  };
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
  const invocation: SetEnabledInvocation = {
    subjects: [row.skillVersionId],
    scope: selection.scope,
    enabled: true,
    ...(selection.invocation === undefined ? {} : { invocation: selection.invocation }),
    dryRun: false,
  };
  return proposeLibraryChange(
    state,
    configuration,
    [{ query: row.skillVersionId, invocation }],
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
    [...byScope.values()].map((scope) => ({
      query: row.skillVersionId,
      invocation: {
        subjects: [row.skillVersionId],
        scope,
        enabled: false,
        dryRun: false,
      },
    })),
  );
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
      invocation: { subjects: [collectionId], scope, enabled, dryRun: false },
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
        invocation: {
          subjects: [row.skillVersionId],
          scope: binding.scope,
          enabled: true,
          invocation,
          dryRun: false,
        },
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
  configuration: ProjectionOptions,
) {
  const pending = state.pending;
  if (pending === undefined) return cancelLibraryChange(state);
  const applied = yield* Effect.result(
    withLibraryWriter(
      Effect.gen(function* () {
        const store = yield* LibraryStore;
        if (libraryStateRevision(yield* store.load) !== pending.libraryRevision)
          return yield* new SetEnabledStale({
            message: "Library changed after this Binding change was previewed",
          });
        yield* Effect.forEach(pending.operations, ({ query, invocation, all }) =>
          Effect.gen(function* () {
            const current = yield* (yield* LibraryStore).load;
            yield* applyLibraryBindings(current, {
              query,
              all: all ?? false,
              invocation,
              roots: configuration,
              variantsPath: configuration.variantsPath,
            });
          }),
        );
      }),
    ),
  );
  const refreshed = yield* openLibrarySession();
  const outcome: LibraryActionOutcome = Result.isSuccess(applied)
    ? { kind: "applied", pending }
    : { kind: "failed", failure: classifyFailure(applied.failure) };
  return { ...refreshed, outcome };
});
