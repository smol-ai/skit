import { resolve } from "node:path";
import { canonicalJson } from "../shared/json.js";
import type { InstallScope } from "../vocabulary.js";
import type { Enabled, LibraryManifest } from "./library-contracts.js";
import type { CollectionId, SkillId } from "./entity-ids.js";
import type { DeviceSkillSelection, InvocationPolicies, LibraryState } from "./library-state.js";

/** What is enabled at one install scope, with the invocation overrides chosen there. */
export interface EnabledAtScope {
  readonly scope: InstallScope;
  readonly enabled: readonly Enabled[];
  readonly invocation_policies?: InvocationPolicies;
}

const GLOBAL = { kind: "global" } as const;

const withPolicies = (policies: InvocationPolicies | undefined) =>
  policies === undefined ? {} : { invocation_policies: policies };

/**
 * What this device installs. The global scope counts only when something is enabled there, or
 * when the device keeps its own choice, which holds even when it enables nothing. Missing explicit
 * choices remain recorded so a later sync cannot silently change consent.
 */
export function deviceInstallationIntent(state: LibraryState, manifest?: LibraryManifest) {
  const selection = state.device_skill_selection;
  const independent = selection?.mode === "choose";
  const missing: Enabled[] = [];
  const library = manifest ?? state;
  const global: EnabledAtScope = independent
    ? {
        scope: GLOBAL,
        enabled: selection.enabled.filter((item) => {
          const present =
            "skill" in item
              ? library.skills.some((skill) => skill.skill_id === item.skill)
              : library.collections.some(
                  (collection) => collection.collection_id === item.collection,
                );
          if (!present) missing.push(item);
          return present;
        }),
        ...withPolicies(selection.invocation_policies),
      }
    : manifest === undefined
      ? { scope: GLOBAL, enabled: state.enabled, ...withPolicies(state.invocation_policies) }
      : { scope: GLOBAL, enabled: manifest.enabled };
  const globals = independent || global.enabled.length > 0 ? [global] : [];
  const repositories = state.repositories.map((repository): EnabledAtScope => ({
    scope: { kind: "repository", root: repository.root },
    enabled: repository.enabled,
    ...withPolicies(repository.invocation_policies),
  }));
  return { independent, globals, byScope: [...globals, ...repositories], missing };
}

/** Keep device installation choices separate from the portable Library being synchronized. */
export function prepareDeviceInstallation(state: LibraryState, manifest: LibraryManifest) {
  const intent = deviceInstallationIntent(state, manifest);
  const selected = { ...manifest, enabled: intent.globals[0]?.enabled ?? [] };
  return {
    ...intent,
    manifest: selected,
    resolveEnabled(enabled: readonly Enabled[]) {
      if (intent.independent) return { account: manifest, installation: selected };
      const installation = { ...manifest, enabled };
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
export function skillsToCheckForDuplicates(
  state: LibraryState,
  scope: InstallScope,
  requested: readonly string[],
  newlyEnabled: readonly string[],
): readonly string[] {
  return state.device_skill_selection?.mode === "choose" && scope.kind === "global"
    ? requested
    : newlyEnabled;
}

type EnabledList = {
  readonly enabled: readonly Enabled[];
  readonly invocation_policies?: InvocationPolicies;
};

/** Transform every place a list is stored together: the account, each repository, the device choice. */
function mapEnabled(
  state: LibraryState,
  transform: (list: EnabledList) => EnabledList,
): LibraryState {
  const global = transform({
    enabled: state.enabled,
    ...withPolicies(state.invocation_policies),
  });
  const { invocation_policies: _policies, ...rest } = state;
  return {
    ...rest,
    enabled: [...global.enabled],
    ...withPolicies(global.invocation_policies),
    repositories: state.repositories.map((repository) => ({
      root: repository.root,
      ...transform(repository),
    })),
    ...(state.device_skill_selection?.mode === "choose"
      ? {
          device_skill_selection: {
            mode: "choose" as const,
            ...transform(state.device_skill_selection),
          },
        }
      : {}),
  };
}

/** Identity alignment changes references in account, repository and explicit device choices alike. */
export function remapEnabled(
  state: LibraryState,
  aliases: {
    readonly skills: readonly { readonly from: SkillId; readonly to: SkillId }[];
    readonly collections: readonly { readonly from: CollectionId; readonly to: CollectionId }[];
  },
): LibraryState {
  return mapEnabled(state, (list) => ({
    enabled: list.enabled.map((item): Enabled =>
      "skill" in item
        ? { skill: aliases.skills.find((alias) => alias.from === item.skill)?.to ?? item.skill }
        : {
            collection:
              aliases.collections.find((alias) => alias.from === item.collection)?.to ??
              item.collection,
          },
    ),
    ...withPolicies(
      list.invocation_policies === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(list.invocation_policies).map(([id, policy]) => [
              aliases.skills.find((alias) => alias.from === id)?.to ?? id,
              policy,
            ]),
          ),
    ),
  }));
}

/** Local removal intentionally prunes explicit choices, unlike unresolved remote removals. */
export function removeFromEnabled(
  state: LibraryState,
  removed: {
    readonly skills: ReadonlySet<string>;
    readonly collections: ReadonlySet<string>;
  },
): LibraryState {
  return pruneEmptyEnabled(
    mapEnabled(state, (list) => {
      const invocation_policies = Object.fromEntries(
        Object.entries(list.invocation_policies ?? {}).filter(([id]) => !removed.skills.has(id)),
      );
      return {
        enabled: list.enabled.filter((item) =>
          "skill" in item
            ? !removed.skills.has(item.skill)
            : !removed.collections.has(item.collection),
        ),
        ...(Object.keys(invocation_policies).length ? { invocation_policies } : {}),
      };
    }),
  );
}

/** What is enabled for every project on this device: its own choice, else the account's. */
export const globalEnabled = (state: LibraryState): EnabledList =>
  state.device_skill_selection?.mode === "choose"
    ? state.device_skill_selection
    : { enabled: state.enabled, ...withPolicies(state.invocation_policies) };

/**
 * Every list this device uses, with its scope: the global one while it enables something or the
 * device keeps its own choice, then each repository's.
 */
export const enabledByScope = (state: LibraryState): EnabledAtScope[] => {
  const global = globalEnabled(state);
  return [
    ...(global.enabled.length > 0 || state.device_skill_selection?.mode === "choose"
      ? [{ scope: GLOBAL, ...global }]
      : []),
    ...state.repositories.map((repository): EnabledAtScope => ({
      scope: { kind: "repository", root: repository.root },
      enabled: repository.enabled,
      ...withPolicies(repository.invocation_policies),
    })),
  ];
};

/** What is enabled at one scope, whether inherited from the account or chosen on this device. */
export const enabledAt = (state: LibraryState, scope: InstallScope): EnabledList | undefined =>
  scope.kind === "global"
    ? globalEnabled(state)
    : state.repositories.find((repository) => resolve(repository.root) === resolve(scope.root));

/**
 * Replace what is enabled at one scope without mutating the captured state. A device choosing its
 * own global selection never changes the account's. Empty repositories remain until their copies
 * have been updated, so this works for both passive plans and authoritative apply.
 */
export function setEnabledAt(
  state: LibraryState,
  scope: InstallScope,
  list: EnabledList,
): LibraryState {
  const next = { enabled: [...list.enabled], ...withPolicies(list.invocation_policies) };
  if (scope.kind === "global") {
    if (state.device_skill_selection?.mode === "choose")
      return { ...state, device_skill_selection: { mode: "choose", ...next } };
    const { invocation_policies: _policies, ...rest } = state;
    return { ...rest, ...next };
  }
  const repository = { root: scope.root, ...next };
  const repositories = [...state.repositories];
  const index = repositories.findIndex((item) => resolve(item.root) === resolve(scope.root));
  if (index < 0) repositories.push(repository);
  else repositories[index] = repository;
  return { ...state, repositories };
}

/**
 * After copies are updated, drop repositories that enable nothing, and the account's invocation
 * overrides once it enables nothing, as dropping an empty Binding did. An empty device choice
 * means "enable nothing", so it survives rather than fall back to the account. Return the original
 * state when nothing needs saving.
 */
export function pruneEmptyEnabled(state: LibraryState): LibraryState {
  const repositories = state.repositories.filter((repository) => repository.enabled.length > 0);
  const clearPolicies = state.enabled.length === 0 && state.invocation_policies !== undefined;
  if (repositories.length === state.repositories.length && !clearPolicies) return state;
  const { invocation_policies: _policies, ...rest } = state;
  return { ...(clearPolicies ? rest : state), repositories };
}
