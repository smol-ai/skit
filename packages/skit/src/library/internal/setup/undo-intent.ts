import { canonicalJson } from "../../../shared/json.js";
import {
  currentCollectionSkills,
  currentSkillVersion,
  type Import,
} from "../../library-contracts.js";
import { Enabled } from "../../library-contracts.js";
import { InvocationPolicies, Repository } from "../../device-state.js";
import { SkillId } from "../../entity-ids.js";
import { type LibraryState } from "../../library-state.js";
import { type SetupIntent } from "./intent.js";

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
  before: SetupIntent,
  expected: SetupIntent,
  restoredSources: readonly Import[] = [],
) => {
  const selectedSourceState = restoredSources.length
    ? { ...state, imports: [...state.imports, ...restoredSources] }
    : state;
  const conflicts: string[] = [];
  const restore = <A>(label: string, prior: A, after: A, current: A): A => {
    if (equal(prior, after) || equal(current, prior)) return current;
    if (equal(current, after)) return prior;
    conflicts.push(label);
    return current;
  };
  const reverseList = (
    label: string,
    prior: EnabledList | undefined,
    after: EnabledList | undefined,
    current: EnabledList | undefined,
  ) => {
    const items = [...(current?.enabled ?? [])];
    const old = new Map((prior?.enabled ?? []).map((item) => [itemKey(item), item]));
    const next = new Map((after?.enabled ?? []).map((item) => [itemKey(item), item]));
    for (const key of new Set([...old.keys(), ...next.keys()])) {
      const was = old.get(key);
      const wanted = next.get(key);
      const enabled = items.some((item) => itemKey(item) === key);
      const reversed = restore(`${label} ${key}`, was !== undefined, wanted !== undefined, enabled);
      if (!reversed) {
        const index = items.findIndex((item) => itemKey(item) === key);
        if (index >= 0) items.splice(index, 1);
      } else if (!enabled && was) {
        const imported =
          "skill" in was
            ? state.skills.some((skill) => skill.skill_id === was.skill)
            : state.collections.some((collection) => collection.collection_id === was.collection);
        if (imported) items.push(was);
        else conflicts.push(`${label} missing retained ${key}`);
      }
    }
    const policies = { ...current?.invocation_policies };
    for (const id of new Set([
      ...Object.keys(prior?.invocation_policies ?? {}),
      ...Object.keys(after?.invocation_policies ?? {}),
    ])) {
      const key = SkillId.make(id);
      const policy = restore(
        `${label} invocation ${key}`,
        prior?.invocation_policies?.[key],
        after?.invocation_policies?.[key],
        policies[key],
      );
      if (policy === undefined) delete policies[key];
      else policies[key] = policy;
    }
    if (!current && !items.length && !Object.keys(policies).length) return undefined;
    return {
      enabled: items,
      ...(Object.keys(policies).length ? { invocation_policies: policies } : {}),
    };
  };
  const currentGlobal = { enabled: state.enabled, ...withPolicies(state.invocation_policies) };
  const global = equal(before.global, expected.global)
    ? currentGlobal
    : (reverseList("account binding", before.global, expected.global, currentGlobal) ??
      currentGlobal);
  const repositories = [...state.repositories];
  const roots = new Set(
    [...before.repositories, ...expected.repositories].map((repository) => repository.root),
  );
  for (const root of roots) {
    const prior = before.repositories.find((repository) => repository.root === root);
    const after = expected.repositories.find((repository) => repository.root === root);
    const index = repositories.findIndex((repository) => repository.root === root);
    const current = repositories[index];
    const reversed = reverseList(`repository binding ${root}`, prior, after, current);
    if (equal(prior, after)) continue;
    if (
      reversed &&
      (reversed.enabled.length ||
        prior ||
        Object.keys(reversed.invocation_policies ?? {}).length ||
        hasAdditionalFields(current ?? prior ?? after ?? { root, enabled: [] }))
    ) {
      // Keep fields a newer SKIT stored on the record; replace only what undo reverses.
      const {
        enabled: _enabled,
        invocation_policies: _policies,
        ...kept
      } = current ?? prior ?? after ?? { root, enabled: [] };
      const repository: Repository = { ...kept, ...reversed, root };
      if (index >= 0) repositories[index] = repository;
      else repositories.push(repository);
    } else if (index >= 0) repositories.splice(index, 1);
  }
  let device = state.device_skill_selection ?? null;
  if (before.device?.mode === "choose" && expected.device?.mode === "choose") {
    if (device?.mode !== "choose") {
      if (!equal(before.device, expected.device)) conflicts.push("device binding selection mode");
    } else {
      const reversed = reverseList("device binding", before.device, expected.device, device);
      device = { mode: "choose", ...(reversed ?? device) };
    }
  } else device = restore("device selection", before.device, expected.device, device);
  const skills = state.skills.map((skill) => {
    const prior = before.versions.find((item) => item.skillId === skill.skill_id);
    const after = expected.versions.find((item) => item.skillId === skill.skill_id);
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
      conflicts.push(`selected Version ${skill.skill_id}`);
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
  for (const prior of before.versions) {
    const after = expected.versions.find((item) => item.skillId === prior.skillId);
    if (
      after &&
      !equal(prior, after) &&
      !state.skills.some((skill) => skill.skill_id === prior.skillId)
    )
      conflicts.push(`missing retained Skill ${prior.skillId}`);
  }
  const { device_skill_selection: _device, invocation_policies: _policies, ...rest } = state;
  const next: LibraryState = {
    ...rest,
    enabled: [...global.enabled],
    ...withPolicies(global.invocation_policies),
    repositories,
    skills,
    imports: selectedSourceState.imports,
    ...(device === null ? {} : { device_skill_selection: device }),
  };
  // Per-Skill inverses alone cannot restore a followed Collection's members. Verify the
  // resulting membership after any separately verified source observations were composed.
  const priorLists: readonly EnabledList[] = [
    before.global,
    ...before.repositories,
    ...(before.device?.mode === "choose" ? [before.device] : []),
  ];
  const currentLists: readonly EnabledList[] = [
    { enabled: next.enabled },
    ...next.repositories,
    ...(next.device_skill_selection?.mode === "choose" ? [next.device_skill_selection] : []),
  ];
  for (const prior of before.memberships ?? []) {
    const after = expected.memberships?.find((item) => item.collectionId === prior.collectionId);
    if (!after || equal(prior, after)) continue;
    const follows = (lists: readonly EnabledList[]) =>
      lists.some((list) =>
        list.enabled.some((item) => "collection" in item && item.collection === prior.collectionId),
      );
    const currentMembers = currentCollectionSkills(next, prior.collectionId)
      .map((skill) => skill.skill_id)
      .sort();
    if (follows(priorLists) && follows(currentLists) && !equal(currentMembers, prior.skillIds))
      conflicts.push(
        `Collection source membership ${prior.collectionId} requires restoration before undo`,
      );
  }
  return { state: next, conflicts, changed: !equal(state, next) };
};
