import {
  LibraryStore,
  withLibraryWriter,
  type HarnessName as Harness,
  type LibraryState,
  type SkitBindingScope as Scope,
} from "@smolai/skit-core";
import { Effect, Result } from "effect";
import { harnessLabel } from "../../harness/catalog.js";
import type { InvocationOption } from "../../invocation/policy.js";
import { invocationHarnesses } from "../../invocation/policy.js";
import {
  invocationReadModel,
  type InvocationHarness,
  type InvocationReadModel,
} from "../../invocation/read-model.js";
import { bindingRowLabel, destinationLabel, scopeKey } from "../../library/read-model.js";
import { classifyFailure, type ClassifiedFailure } from "../../failure-classification.js";
import { unspecifiedDeclaredInvocation } from "../../invocation/library-source.js";
import type { ProjectionOptions } from "./projection-options.js";
import {
  applyLibraryBindings,
  libraryStateRevision,
  PortableSetEnabledStale,
  previewLibraryBindings,
} from "./portable-set-enabled.js";
import type { SetEnabledInvocation } from "./set-enabled.js";

export interface LibraryBindingRow {
  readonly harness: Harness;
  readonly scope: Scope;
  readonly invocation: InvocationOption;
  readonly policy?: InvocationReadModel;
  readonly label: string;
}

export interface LibrarySkillRow {
  readonly name: string;
  readonly skillVersionId: string;
  readonly collectionId: string;
  readonly heading: string;
  readonly bindings: readonly LibraryBindingRow[];
}

export interface PreviewFacts {
  readonly action: "enable" | "disable";
  readonly skills: readonly string[];
  readonly harnesses: readonly Harness[];
  readonly harnessLabels: readonly string[];
  readonly scope: Scope;
  readonly destination: string;
  readonly invocation?: InvocationOption;
  readonly writes: "projection created" | "projection removed";
}

interface PendingOperation {
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
  readonly harnesses: readonly Harness[];
  readonly skills: readonly LibrarySkillRow[];
  readonly pending?: PendingLibraryChange;
  readonly outcome?: LibraryActionOutcome;
}

const bindingRows = (
  state: LibraryState,
  collectionId: string,
  skillId: LibraryState["skills"][number]["skill_id"],
  skillName: string,
): LibraryBindingRow[] =>
  [...state.global_bindings, ...state.local_bindings]
    .filter((binding) => binding.collection_id === collectionId && binding.skills.includes(skillId))
    .map((binding) => {
      const invocation = (binding.invocation_policies?.[skillId] ?? "declared") as InvocationOption;
      const carriesPolicy = (invocationHarnesses as readonly Harness[]).includes(binding.harness);
      const policy = carriesPolicy
        ? invocationReadModel({
            skill: skillName,
            harness: binding.harness as InvocationHarness,
            author: unspecifiedDeclaredInvocation()[binding.harness as InvocationHarness],
            storedIntent: invocation,
          })
        : undefined;
      return {
        harness: binding.harness,
        scope: binding.scope,
        invocation,
        ...(policy === undefined ? {} : { policy }),
        label: bindingRowLabel({
          harness: binding.harness,
          scope: binding.scope,
          ...(policy === undefined ? {} : { policy }),
        }),
      };
    });

const skillRows = (state: LibraryState): LibrarySkillRow[] =>
  state.collections.flatMap((collection) => {
    const heading = collection.display_name;
    return state.skills
      .filter((candidate) => candidate.collection_id === collection.collection_id)
      .flatMap((skill) => {
        const version = skill?.versions.find(
          (candidate) => candidate.skill_version_id === skill.selected_skill_version_id,
        );
        if (skill === undefined || version === undefined) return [];
        return [
          {
            name: skill.name,
            skillVersionId: version.skill_version_id,
            collectionId: collection.collection_id,
            heading,
            bindings: bindingRows(state, collection.collection_id, skill.skill_id, skill.name),
          },
        ];
      });
  });

export const openLibrarySession = Effect.fn("LibrarySession.open")(function* (
  harnesses: readonly Harness[],
) {
  const state = yield* (yield* LibraryStore).load;
  return { harnesses, skills: skillRows(state) } satisfies LibrarySessionState;
});

export const refreshLibrarySession = Effect.fn("LibrarySession.refresh")(function* (
  state: LibrarySessionState,
) {
  return {
    ...(yield* openLibrarySession(state.harnesses)),
    ...(state.outcome === undefined ? {} : { outcome: state.outcome }),
  } satisfies LibrarySessionState;
});

export function libraryPolicyAfter(
  row: LibrarySkillRow,
  harness: Harness,
  intent: InvocationOption,
): InvocationReadModel | undefined {
  if (!(invocationHarnesses as readonly Harness[]).includes(harness)) return undefined;
  return invocationReadModel({
    skill: row.name,
    harness: harness as InvocationHarness,
    author: unspecifiedDeclaredInvocation()[harness as InvocationHarness],
    storedIntent: intent,
  });
}

const factFromPlan = (
  plan: Effect.Success<ReturnType<typeof previewLibraryBindings>>,
): PreviewFacts => ({
  action: plan.enabled ? "enable" : "disable",
  skills: plan.skills,
  harnesses: plan.harnesses,
  harnessLabels: plan.harnesses.map(harnessLabel),
  scope: plan.scope,
  destination: destinationLabel(plan.scope),
  ...(plan.invocation === undefined ? {} : { invocation: plan.invocation }),
  writes: plan.enabled ? "projection created" : "projection removed",
});

const proposeLibraryChange = Effect.fn("LibrarySession.propose")(function* (
  state: LibrarySessionState,
  operations: readonly PendingOperation[],
  policies: readonly InvocationReadModel[] = [],
) {
  const attempted = yield* Effect.result(
    Effect.gen(function* () {
      const current = yield* (yield* LibraryStore).load;
      return {
        libraryRevision: libraryStateRevision(current),
        plans: yield* Effect.forEach(operations, ({ query, invocation }) =>
          previewLibraryBindings(current, {
            query,
            all: false,
            invocation,
            roots: { home: "", configHome: "", overrides: {} },
            variantsPath: "",
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
    facts: attempted.success.plans.map(factFromPlan),
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
  _configuration: ProjectionOptions,
  row: LibrarySkillRow,
  selection: {
    readonly harnesses: readonly Harness[];
    readonly scope: Scope;
    readonly invocation?: InvocationOption;
  },
) {
  const invocation: SetEnabledInvocation = {
    subjects: [row.skillVersionId],
    harnesses: selection.harnesses,
    scope: selection.scope,
    enabled: true,
    ...(selection.invocation === undefined ? {} : { invocation: selection.invocation }),
    dryRun: false,
  };
  return proposeLibraryChange(
    state,
    [{ query: row.skillVersionId, invocation }],
    selection.harnesses.flatMap(
      (harness) => libraryPolicyAfter(row, harness, selection.invocation ?? "declared") ?? [],
    ),
  );
}

export function proposeLibraryDisable(
  state: LibrarySessionState,
  _configuration: ProjectionOptions,
  row: LibrarySkillRow,
  bindings: readonly LibraryBindingRow[],
) {
  const byScope = new Map<string, { scope: Scope; harnesses: Harness[] }>();
  for (const binding of bindings) {
    const key = scopeKey(binding.scope);
    const group = byScope.get(key) ?? { scope: binding.scope, harnesses: [] };
    if (!group.harnesses.includes(binding.harness)) group.harnesses.push(binding.harness);
    byScope.set(key, group);
  }
  return proposeLibraryChange(
    state,
    [...byScope.values()].map(({ scope, harnesses }) => ({
      query: row.skillVersionId,
      invocation: {
        subjects: [row.skillVersionId],
        harnesses,
        scope,
        enabled: false,
        dryRun: false,
      },
    })),
  );
}

export function proposeLibraryInvocation(
  state: LibrarySessionState,
  _configuration: ProjectionOptions,
  row: LibrarySkillRow,
  binding: LibraryBindingRow,
  invocation: InvocationOption,
) {
  return proposeLibraryChange(
    state,
    [
      {
        query: row.skillVersionId,
        invocation: {
          subjects: [row.skillVersionId],
          harnesses: [binding.harness],
          scope: binding.scope,
          enabled: true,
          invocation,
          dryRun: false,
        },
      },
    ],
    [libraryPolicyAfter(row, binding.harness, invocation)].filter(
      (policy): policy is InvocationReadModel => policy !== undefined,
    ),
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
          return yield* new PortableSetEnabledStale({
            message: "Library changed after this Binding change was previewed",
          });
        yield* Effect.forEach(pending.operations, ({ query, invocation }) =>
          Effect.gen(function* () {
            const current = yield* (yield* LibraryStore).load;
            yield* applyLibraryBindings(current, {
              query,
              all: false,
              invocation,
              roots: configuration,
              variantsPath: configuration.variantsPath,
            });
          }),
        );
      }),
    ),
  );
  const refreshed = yield* openLibrarySession(state.harnesses);
  const outcome: LibraryActionOutcome = Result.isSuccess(applied)
    ? { kind: "applied", pending }
    : { kind: "failed", failure: classifyFailure(applied.failure) };
  return { ...refreshed, outcome };
});
