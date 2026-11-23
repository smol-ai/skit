import type { UndoConflict } from "../../recovery-facts.js";
import { canonicalJson } from "../../../shared/json.js";
import {
  currentCollectionSkills,
  currentSkillVersion,
  type Import,
} from "../../library-contracts.js";
import { Enabled } from "../../library-contracts.js";
import { InvocationPolicies, Repository, type DeviceSkillSelection } from "../../device-state.js";
import {
  prepareLibrarySets,
  libraryStateRevision,
  type LibraryState,
} from "../../library-state.js";
import { type SetupIntentChanges } from "../../store/setup-intent.js";

const withPolicies = (invocation_policies: InvocationPolicies | undefined) =>
  invocation_policies === undefined ? {} : { invocation_policies };

const equal = (left: unknown, right: unknown) =>
  canonicalJson(left ?? null) === canonicalJson(right ?? null);
interface EnabledList {
  readonly enabled: readonly Enabled[];
  readonly invocation_policies?: InvocationPolicies;
}
const itemKey = (item: Enabled) =>
  "skill" in item ? `skill:${item.skill}` : `collection:${item.collection}`;

const hasAdditionalFields = (repository: Repository) =>
  Object.keys(repository).some((key) => !["root", "enabled", "invocation_policies"].includes(key));

/** Compute an inverse without saving it. Only the operation's changed keys can be reversed. */
export const reverseSetupIntent = (
  state: LibraryState,
  changes: SetupIntentChanges,
  restoredSources: readonly Import[] = [],
) => {
  state = prepareLibrarySets(state);
  const selectedSourceState = restoredSources.length
    ? { ...state, imports: [...state.imports, ...restoredSources] }
    : state;
  const conflicts: UndoConflict[] = [];
  const restore = <A>(conflict: UndoConflict, prior: A, after: A, current: A): A => {
    if (equal(prior, after) || equal(current, prior)) return current;
    if (equal(current, after)) return prior;
    conflicts.push(conflict);
    return current;
  };
  const reverseSelection = (
    change: SetupIntentChanges["scopes"][number],
    current: EnabledList | undefined,
  ) => {
    const items = new Map((current?.enabled ?? []).map((item) => [itemKey(item), item]));
    for (const row of change.enabled) {
      const present = items.has(row.key);
      const reversed = restore(
        { _tag: "SelectionChanged", scope: change.scope, key: row.key, kind: "enabled" },
        row.before !== undefined,
        row.after !== undefined,
        present,
      );
      if (!reversed) items.delete(row.key);
      else if (!present && row.before) {
        const item = row.before;
        const imported =
          "skill" in item
            ? state.skills.some((skill) => skill.skill_id === item.skill)
            : state.collections.some((collection) => collection.collection_id === item.collection);
        if (imported) items.set(row.key, item);
        else conflicts.push({ _tag: "SelectionMissing", scope: change.scope, key: row.key });
      }
    }
    const policies = new Map(Object.entries(current?.invocation_policies ?? {}));
    for (const row of change.policies) {
      const value = restore(
        { _tag: "SelectionChanged", scope: change.scope, key: row.key, kind: "invocation" },
        row.before,
        row.after,
        policies.get(row.key),
      );
      if (value === undefined) policies.delete(row.key);
      else policies.set(row.key, value);
    }
    if (current === undefined && items.size === 0 && policies.size === 0) return undefined;
    return {
      enabled: [...items.values()],
      ...(policies.size ? { invocation_policies: Object.fromEntries(policies) } : {}),
    };
  };
  const account = changes.scopes.find((row) => row.scope._tag === "Account");
  const currentGlobal = { enabled: state.enabled, ...withPolicies(state.invocation_policies) };
  const global = account
    ? (reverseSelection(account, currentGlobal) ?? currentGlobal)
    : currentGlobal;
  const repositories = new Map(state.repositories.map((row) => [row.root, row]));
  for (const change of changes.scopes) {
    if (change.scope._tag !== "Repository") continue;
    const root = change.scope.root,
      current = repositories.get(root);
    const reversed = reverseSelection(change, current);
    if (
      reversed &&
      (reversed.enabled.length ||
        change.beforePresent ||
        Object.keys(reversed.invocation_policies ?? {}).length ||
        hasAdditionalFields(current ?? { root, enabled: [] }))
    ) {
      const {
        enabled: _enabled,
        invocation_policies: _policies,
        ...kept
      } = current ?? { root, enabled: [] };
      repositories.set(root, { ...kept, ...reversed, root });
    } else repositories.delete(root);
  }
  let device = state.device_skill_selection ?? null;
  const deviceChanges = changes.scopes.find((row) => row.scope._tag === "Device");
  if (changes.device) {
    const mode = changes.device;
    const matches = (side: "before" | "after") => {
      if ((device?.mode ?? null) !== mode[side]) return false;
      if (device === null) return true;
      if (
        Object.keys(device).some((key) => !["mode", "enabled", "invocation_policies"].includes(key))
      )
        return false;
      if (device.mode !== "choose") return true;
      const items = new Map(device.enabled.map((item) => [itemKey(item), item]));
      const policies = new Map(Object.entries(device.invocation_policies ?? {}));
      return (
        items.size ===
          (deviceChanges?.enabled.filter((row) => row[side] !== undefined).length ?? 0) &&
        policies.size ===
          (deviceChanges?.policies.filter((row) => row[side] !== undefined).length ?? 0) &&
        (deviceChanges?.enabled.every((row) => equal(items.get(row.key), row[side])) ?? true) &&
        (deviceChanges?.policies.every((row) => equal(policies.get(row.key), row[side])) ?? true)
      );
    };
    if (!matches("before") && !matches("after")) conflicts.push({ _tag: "DeviceSelectionChanged" });
    else if (mode.before === null) device = null;
    else if (mode.before === "follow-account") device = { mode: "follow-account" };
    else {
      const current: Extract<DeviceSkillSelection, { mode: "choose" }> =
        device?.mode === "choose" ? device : { mode: "choose", enabled: [] };
      const reversed = deviceChanges ? reverseSelection(deviceChanges, current) : undefined;
      const { enabled: _enabled, invocation_policies: _policies, ...kept } = current;
      device = { ...kept, ...(reversed ?? { enabled: [] }) };
    }
  } else if (deviceChanges) {
    if (device?.mode !== "choose") conflicts.push({ _tag: "DeviceModeChanged" });
    else {
      const reversed = reverseSelection(deviceChanges, device);
      const { enabled: _enabled, invocation_policies: _policies, ...kept } = device;
      device = { ...kept, ...(reversed ?? { enabled: [] }) };
    }
  }
  const skills = state.skills.map((skill) => {
    const row = changes.versions.find((item) => item.key === skill.skill_id);
    const prior = row?.before,
      after = row?.after;
    // Retained new Skills remain available; undo reverses their enablement, not their retention.
    if (!prior || !after || equal(prior, after)) return skill;
    const selected = currentSkillVersion(state, skill)?.skill_version_id ?? null;
    const current = { skillId: skill.skill_id, selected, local: skill.local_version_id ?? null };
    if (
      equal(current, prior) ||
      (selected === prior.selected && prior.local === null && current.local === prior.selected)
    )
      return skill;
    if (
      !equal(current, after) ||
      prior.selected === null ||
      !skill.versions.some((version) => version.skill_version_id === prior.selected)
    ) {
      conflicts.push({ _tag: "SkillVersionChanged", skillId: skill.skill_id });
      return skill;
    }
    const { local_version_id: _local, ...rest } = skill;
    const candidate = {
      ...rest,
      ...(prior.local === null ? {} : { local_version_id: prior.local }),
    };
    return currentSkillVersion(selectedSourceState, candidate)?.skill_version_id === prior.selected
      ? candidate
      : { ...candidate, local_version_id: prior.selected };
  });
  for (const { before: prior, after } of changes.versions) {
    if (
      prior &&
      after &&
      !equal(prior, after) &&
      !state.skills.some((skill) => skill.skill_id === prior.skillId)
    )
      conflicts.push({ _tag: "SkillMissing", skillId: prior.skillId });
  }
  const { device_skill_selection: _device, invocation_policies: _policies, ...rest } = state;
  const next: LibraryState = {
    ...rest,
    enabled: [...global.enabled],
    ...withPolicies(global.invocation_policies),
    repositories: [...repositories.values()],
    skills,
    imports: selectedSourceState.imports,
    ...(device === null ? {} : { device_skill_selection: device }),
  };
  // Per-Skill inverses alone cannot restore a followed Collection's members. Verify the
  // resulting membership after any separately verified source observations were composed.
  const currentLists: readonly EnabledList[] = [
    { enabled: next.enabled },
    ...next.repositories,
    ...(next.device_skill_selection?.mode === "choose" ? [next.device_skill_selection] : []),
  ];
  for (const { before: prior, after, followedBefore } of changes.memberships) {
    if (!prior || !after || equal(prior, after)) continue;
    const follows = currentLists.some((list) =>
      list.enabled.some((item) => "collection" in item && item.collection === prior.collectionId),
    );
    const currentMembers = currentCollectionSkills(next, prior.collectionId)
      .map((skill) => skill.skill_id)
      .sort();
    if (followedBefore && follows && !equal(currentMembers, [...prior.skillIds].sort()))
      conflicts.push({ _tag: "CollectionMembershipChanged", collectionId: prior.collectionId });
  }
  return {
    state: prepareLibrarySets(next),
    conflicts,
    changed: libraryStateRevision(state) !== libraryStateRevision(next),
  };
};
