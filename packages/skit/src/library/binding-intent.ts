import { resolve } from "node:path";
import { canonicalJson } from "../shared/json.js";
import type { SkitBindingScope } from "../vocabulary.js";
import type { Binding, BindingEntry, LibraryManifest } from "./library-contracts.js";
import type { CollectionId, SkillId } from "./entity-ids.js";
import type {
  DeviceBinding,
  DeviceSkillSelection,
  LibraryState,
  RepositoryBinding,
} from "./library-state.js";

/** Missing explicit choices remain recorded so a later sync cannot silently change consent. */
export function deviceInstallationIntent(state: LibraryState, manifest?: LibraryManifest) {
  const selection = state.device_skill_selection;
  const independent = selection?.mode === "choose";
  const missing: BindingEntry[] = [];
  const library = manifest ?? state;
  const bindings: readonly DeviceBinding[] = independent
    ? [
        {
          ...selection.binding,
          entries: selection.binding.entries.filter((entry) => {
            const present =
              entry.kind === "skill"
                ? library.skills.some((skill) => skill.skill_id === entry.skill_id)
                : library.collections.some(
                    (collection) => collection.collection_id === entry.collection_id,
                  );
            if (!present) missing.push(entry);
            return present;
          }),
        },
      ]
    : (manifest?.bindings ?? state.global_bindings);
  return { independent, bindings, allBindings: [...bindings, ...state.local_bindings], missing };
}

/** Keep device installation choices separate from the portable Library being synchronized. */
export function prepareDeviceInstallation(state: LibraryState, manifest: LibraryManifest) {
  const intent = deviceInstallationIntent(state, manifest);
  const selected = { ...manifest, bindings: intent.bindings };
  return {
    ...intent,
    manifest: selected,
    resolveBindings(bindings: readonly Binding[]) {
      if (intent.independent) return { account: manifest, installation: selected };
      const installation = { ...manifest, bindings };
      return { account: installation, installation };
    },
  };
}

/** A completed sync consumes a pending selection origin; an empty remote may retain it. */
export function withDeviceSkillSelection(
  state: LibraryState,
  selection?: DeviceSkillSelection,
  pendingOrigin?: string,
): LibraryState {
  const { pending_device_selection_origin: _pending, ...current } = state;
  return {
    ...current,
    ...(selection === undefined ? {} : { device_skill_selection: selection }),
    ...(pendingOrigin === undefined ? {} : { pending_device_selection_origin: pendingOrigin }),
  };
}

export const sameDeviceSkillSelection = (left: LibraryState, right: LibraryState): boolean =>
  canonicalJson(left.device_skill_selection ?? null) ===
  canonicalJson(right.device_skill_selection ?? null);

/** Explicit device enablement verifies every requested Skill, including unchanged intent. */
export function bindingShadowCheckSkills(
  state: LibraryState,
  scope: SkitBindingScope,
  requested: readonly string[],
  newlyEnabled: readonly string[],
): readonly string[] {
  return state.device_skill_selection?.mode === "choose" && scope.kind === "global"
    ? requested
    : newlyEnabled;
}

/** Transform all binding locations together; callers need not enumerate account/device storage. */
function mapBindings(
  state: LibraryState,
  transform: (binding: DeviceBinding | RepositoryBinding) => DeviceBinding | RepositoryBinding,
): LibraryState {
  return {
    ...state,
    global_bindings: state.global_bindings.map((binding) => ({
      ...transform(binding),
      scope: binding.scope,
    })),
    local_bindings: state.local_bindings.map((binding) => ({
      ...transform(binding),
      scope: binding.scope,
    })),
    ...(state.device_skill_selection?.mode === "choose"
      ? {
          device_skill_selection: {
            ...state.device_skill_selection,
            binding: {
              ...transform(state.device_skill_selection.binding),
              scope: state.device_skill_selection.binding.scope,
            },
          },
        }
      : {}),
  };
}

/** Identity alignment changes references in account, repository and explicit device choices alike. */
export function remapBindingEntities(
  state: LibraryState,
  aliases: {
    readonly skills: readonly { readonly from: SkillId; readonly to: SkillId }[];
    readonly collections: readonly { readonly from: CollectionId; readonly to: CollectionId }[];
  },
): LibraryState {
  return mapBindings(state, (binding) => ({
    ...binding,
    entries: binding.entries.map((entry): BindingEntry =>
      entry.kind === "skill"
        ? {
            ...entry,
            skill_id:
              aliases.skills.find((alias) => alias.from === entry.skill_id)?.to ?? entry.skill_id,
          }
        : {
            ...entry,
            collection_id:
              aliases.collections.find((alias) => alias.from === entry.collection_id)?.to ??
              entry.collection_id,
          },
    ),
    ...(binding.invocation_policies === undefined
      ? {}
      : {
          invocation_policies: Object.fromEntries(
            Object.entries(binding.invocation_policies).map(([id, policy]) => [
              aliases.skills.find((alias) => alias.from === id)?.to ?? id,
              policy,
            ]),
          ),
        }),
  }));
}

/** Local removal intentionally prunes explicit choices, unlike unresolved remote removals. */
export function removeBindingEntities(
  state: LibraryState,
  removed: {
    readonly skills: ReadonlySet<string>;
    readonly collections: ReadonlySet<string>;
  },
): LibraryState {
  return pruneEmptyBindings(
    mapBindings(state, (original) => {
      const { invocation_policies: policies, ...binding } = original;
      const invocation_policies = Object.fromEntries(
        Object.entries(policies ?? {}).filter(([id]) => !removed.skills.has(id)),
      );
      return {
        ...binding,
        entries: binding.entries.filter((entry) =>
          entry.kind === "skill"
            ? !removed.skills.has(entry.skill_id)
            : !removed.collections.has(entry.collection_id),
        ),
        ...(Object.keys(invocation_policies).length ? { invocation_policies } : {}),
      };
    }),
  );
}

/** Effective global intent for this device; absence preserves the historical account-following mode. */
export const effectiveGlobalBindings = (state: LibraryState): readonly DeviceBinding[] =>
  state.device_skill_selection?.mode === "choose"
    ? [state.device_skill_selection.binding]
    : state.global_bindings;

/** The enabled selection at a Scope, whether inherited from the account or chosen locally. */
export const scopeBinding = (
  state: LibraryState,
  scope: SkitBindingScope,
): DeviceBinding | RepositoryBinding | undefined =>
  scope.kind === "global"
    ? effectiveGlobalBindings(state)[0]
    : state.local_bindings.find((binding) => resolve(binding.scope.root) === resolve(scope.root));

/**
 * Replace enabled intent at one Scope without mutating the captured state. A device choosing its
 * own global selection never changes account Bindings. Empty Bindings remain until their copies
 * have been reconciled, so this operation works for both passive previews and authoritative apply.
 */
export function replaceScopeBinding(
  state: LibraryState,
  binding: DeviceBinding | RepositoryBinding,
): LibraryState {
  if (binding.scope.kind === "global") {
    const global = { ...binding, scope: binding.scope };
    return state.device_skill_selection?.mode === "choose"
      ? { ...state, device_skill_selection: { ...state.device_skill_selection, binding: global } }
      : { ...state, global_bindings: [global] };
  }
  const repository = { ...binding, scope: binding.scope };
  const local_bindings = [...state.local_bindings];
  const index = local_bindings.findIndex(
    (item) => resolve(item.scope.root) === resolve(repository.scope.root),
  );
  if (index < 0) local_bindings.push(repository);
  else local_bindings[index] = repository;
  return { ...state, local_bindings };
}

/**
 * After reconciliation, discard empty account and repository Bindings. An empty device selection
 * means "enable nothing", so it must survive rather than fall back to the account. Return the
 * original state when nothing needs saving.
 */
export function pruneEmptyBindings(state: LibraryState): LibraryState {
  const global_bindings = state.global_bindings.filter((binding) => binding.entries.length > 0);
  const local_bindings = state.local_bindings.filter((binding) => binding.entries.length > 0);
  return global_bindings.length === state.global_bindings.length &&
    local_bindings.length === state.local_bindings.length
    ? state
    : { ...state, global_bindings, local_bindings };
}
