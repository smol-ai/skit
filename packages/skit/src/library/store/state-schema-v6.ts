import { Schema } from "effect";
import { resolve } from "node:path";
import { SkillId } from "../entity-ids.js";
import {
  Acquisition,
  BindingEntry,
  bindingSkillIds,
  Collection,
  mergeBindingEntries,
  RetainedCopy,
  Skill,
} from "../library-contracts.js";
import {
  AbsoluteDevicePath,
  currentLibraryState,
  ManagedProjection,
  type LibraryState,
} from "../library-state.js";
import { BindingV6 } from "../library-contracts-v6.js";
import {
  HarnessName,
  InvocationPolicy,
  LibraryDeviceStateFields,
  type RecordedProjectionTarget,
} from "./state-schema.js";

const DeviceBindingV6 = Schema.Struct({
  ...BindingV6.fields,
  invocation_policies: Schema.optionalKey(Schema.Record(SkillId, InvocationPolicy)),
});
const RepositoryBindingV6 = Schema.Struct({
  harness: HarnessName,
  scope: Schema.Struct({ kind: Schema.Literal("repository"), root: AbsoluteDevicePath }),
  entries: Schema.Array(BindingEntry),
  invocation_policies: Schema.optionalKey(Schema.Record(SkillId, InvocationPolicy)),
});
const { target: _target, ...projectionFields } = ManagedProjection.fields;
const ManagedProjectionV6 = Schema.Struct({ ...projectionFields, harness: HarnessName });

/** Frozen v6 state: Bindings and Projections were keyed by Harness. */
export const LibraryStateV6 = Schema.Struct({
  ...LibraryDeviceStateFields,
  schemaVersion: Schema.Literal(6),
  collections: Schema.Array(Collection),
  skills: Schema.Array(Skill),
  retained_copies: Schema.Array(RetainedCopy),
  acquisitions: Schema.Array(Acquisition),
  global_bindings: Schema.Array(DeviceBindingV6),
  local_bindings: Schema.Array(RepositoryBindingV6),
  projections: Schema.Array(ManagedProjectionV6),
});
export type LibraryStateV6 = typeof LibraryStateV6.Type;

const projectionTargets = {
  codex: "agents",
  "claude-code": "claude",
  opencode: "legacy",
  devin: "legacy",
} as const satisfies Record<HarnessName, RecordedProjectionTarget>;

/**
 * Merge per-Harness Bindings at one Scope. An invocation override survives only when every
 * merged Binding that enables the Skill chose the same one; otherwise the Skill's declared
 * policy applies, because no single override can honour Harnesses that disagreed.
 */
const mergeScopeBindings = (
  state: LibraryStateV6,
  bindings: readonly (typeof DeviceBindingV6.Type | typeof RepositoryBindingV6.Type)[],
) => {
  const entries = mergeBindingEntries(state, bindings);
  const policies: Record<string, InvocationPolicy> = {};
  for (const skillId of new Set(bindings.flatMap((binding) => bindingSkillIds(state, binding)))) {
    const chosen = new Set(
      bindings
        .filter((binding) => bindingSkillIds(state, binding).includes(skillId))
        .map((binding) => binding.invocation_policies?.[skillId]),
    );
    const [policy] = chosen;
    if (chosen.size === 1 && policy !== undefined) policies[skillId] = policy;
  }
  return { entries, ...(Object.keys(policies).length ? { invocation_policies: policies } : {}) };
};

export const migrateLibraryStateFromV6 = (state: LibraryStateV6): LibraryState => {
  const { schemaVersion: _legacyVersion, global_bindings, local_bindings, ...fields } = state;
  const global = mergeScopeBindings(state, global_bindings);
  const roots = new Map<string, (typeof local_bindings)[number][]>();
  for (const binding of local_bindings) {
    const root = resolve(binding.scope.root);
    roots.set(root, [...(roots.get(root) ?? []), binding]);
  }
  return currentLibraryState({
    ...fields,
    collections: [...state.collections],
    skills: [...state.skills],
    retained_copies: [...state.retained_copies],
    acquisitions: [...state.acquisitions],
    global_bindings: global.entries.length ? [{ ...global, scope: { kind: "global" } }] : [],
    local_bindings: [...roots].flatMap(([root, bindings]) => {
      const merged = mergeScopeBindings(state, bindings);
      return merged.entries.length
        ? [{ ...merged, scope: { kind: "repository" as const, root } }]
        : [];
    }),
    projections: state.projections.map(({ harness, ...projection }) => ({
      ...projection,
      target: projectionTargets[harness],
    })),
  });
};
