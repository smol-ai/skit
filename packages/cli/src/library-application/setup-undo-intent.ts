import { Schema } from "effect";
import {
  canonicalJson,
  ImportId,
  CollectionId,
  currentCollectionSkills,
  currentSkillVersion,
  DeviceBinding,
  DeviceSkillSelection,
  RepositoryBinding,
  RetainedCopyId,
  SkillId,
  SkillVersionId,
  CurrentMachineDocument,
  sourceImports,
  type LibraryState,
  type Import,
  type MachineSettingsSnapshot,
} from "@smolai/skit-core";

/** The desired fields setup can change. Retained artifacts and audit history are not inverse data. */
export const SetupIntent = Schema.Struct({
  global: Schema.Array(DeviceBinding),
  repositories: Schema.Array(RepositoryBinding),
  device: Schema.NullOr(DeviceSkillSelection),
  sources: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        collectionId: CollectionId,
        acquisitionId: ImportId,
        retainedCopyId: RetainedCopyId,
      }),
    ),
  ),
  memberships: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        collectionId: CollectionId,
        skillIds: Schema.Array(SkillId),
      }),
    ),
  ),
  versions: Schema.Array(
    Schema.Struct({
      skillId: SkillId,
      selected: Schema.NullOr(SkillVersionId),
      local: Schema.NullOr(SkillVersionId),
    }),
  ),
});
export type SetupIntent = typeof SetupIntent.Type;

export const setupIntent = (state: LibraryState): SetupIntent => ({
  global: structuredClone(state.global_bindings),
  repositories: structuredClone(state.local_bindings),
  device: structuredClone(state.device_skill_selection ?? null),
  sources: state.collections
    .flatMap((collection) => {
      const selected = sourceImports(state, collection.collection_id)[0];
      return selected
        ? [
            {
              collectionId: collection.collection_id,
              acquisitionId: selected.acquisition_id,
              retainedCopyId: selected.retained_copy_id,
            },
          ]
        : [];
    })
    .sort((left, right) => left.collectionId.localeCompare(right.collectionId)),
  memberships: state.collections
    .map((collection) => ({
      collectionId: collection.collection_id,
      skillIds: currentCollectionSkills(state, collection.collection_id)
        .map((skill) => skill.skill_id)
        .sort(),
    }))
    .sort((left, right) => left.collectionId.localeCompare(right.collectionId)),
  versions: state.skills
    .map((skill) => ({
      skillId: skill.skill_id,
      selected: currentSkillVersion(state, skill)?.skill_version_id ?? null,
      local: skill.local_version_id ?? null,
    }))
    .sort((left, right) => left.skillId.localeCompare(right.skillId)),
});

export const SetupDiscoverySettings = Schema.Struct({
  discoveryRoots: CurrentMachineDocument.fields.discoveryRoots,
  repositories: CurrentMachineDocument.fields.repositories,
  initialized: Schema.Boolean,
  displayName: Schema.NullOr(Schema.NonEmptyString),
});
export type SetupDiscoverySettings = typeof SetupDiscoverySettings.Type;
export const setupDiscoverySettings = (
  settings: MachineSettingsSnapshot,
): SetupDiscoverySettings => ({
  discoveryRoots: [...settings.discoveryRoots],
  repositories: structuredClone(settings.repositories),
  initialized: settings.repositoryDecisionsInitialized,
  displayName: settings.displayName ?? null,
});

const equal = (left: unknown, right: unknown) =>
  canonicalJson(left ?? null) === canonicalJson(right ?? null);
type Binding = DeviceBinding | RepositoryBinding;
const entryKey = (entry: Binding["entries"][number]) =>
  entry.kind === "skill" ? `skill:${entry.skill_id}` : `collection:${entry.collection_id}`;

const hasAdditionalFields = (binding: Binding) =>
  Object.keys(binding).some((key) => !["scope", "entries", "invocation_policies"].includes(key)) ||
  Object.keys(binding.scope).some((key) => !["kind", "root"].includes(key));

/** Compute an inverse without saving it. Only the operation's changed keys can be reversed. */
export const reverseSetupIntent = (
  state: LibraryState,
  before: SetupIntent,
  expected: SetupIntent,
  restoredSources: readonly Import[] = [],
) => {
  const selectedSourceState = restoredSources.length
    ? { ...state, acquisitions: [...state.acquisitions, ...restoredSources] }
    : state;
  const conflicts: string[] = [];
  const restore = <A>(label: string, prior: A, after: A, current: A): A => {
    if (equal(prior, after) || equal(current, prior)) return current;
    if (equal(current, after)) return prior;
    conflicts.push(label);
    return current;
  };
  const reverseBinding = (
    label: string,
    prior: Binding | undefined,
    after: Binding | undefined,
    current: Binding | undefined,
  ) => {
    const entries = [...(current?.entries ?? [])];
    const old = new Map((prior?.entries ?? []).map((entry) => [entryKey(entry), entry]));
    const next = new Map((after?.entries ?? []).map((entry) => [entryKey(entry), entry]));
    for (const key of new Set([...old.keys(), ...next.keys()])) {
      const was = old.get(key);
      const wanted = next.get(key);
      const enabled = entries.some((entry) => entryKey(entry) === key);
      const reversed = restore(`${label} ${key}`, was !== undefined, wanted !== undefined, enabled);
      if (!reversed) {
        const index = entries.findIndex((entry) => entryKey(entry) === key);
        if (index >= 0) entries.splice(index, 1);
      } else if (!enabled && was) {
        const retained =
          was.kind === "skill"
            ? state.skills.some((skill) => skill.skill_id === was.skill_id)
            : state.collections.some(
                (collection) => collection.collection_id === was.collection_id,
              );
        if (retained) entries.push(was);
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
    if (!current && !entries.length && !Object.keys(policies).length) return undefined;
    const shape = current ?? prior ?? after;
    if (!shape) return undefined;
    const { invocation_policies: _policies, ...rest } = shape;
    return {
      ...rest,
      entries,
      ...(Object.keys(policies).length ? { invocation_policies: policies } : {}),
    };
  };
  const global = reverseBinding(
    "account binding",
    before.global[0],
    expected.global[0],
    state.global_bindings[0],
  );
  const global_bindings: DeviceBinding[] = equal(before.global, expected.global)
    ? state.global_bindings
    : global &&
        (global.entries.length ||
          before.global.length ||
          Object.keys(global.invocation_policies ?? {}).length ||
          hasAdditionalFields(global))
      ? [{ ...global, scope: global.scope.kind === "global" ? global.scope : { kind: "global" } }]
      : [];
  const local_bindings = [...state.local_bindings];
  const roots = new Set(
    [...before.repositories, ...expected.repositories].map((binding) => binding.scope.root),
  );
  for (const root of roots) {
    const prior = before.repositories.find((binding) => binding.scope.root === root);
    const after = expected.repositories.find((binding) => binding.scope.root === root);
    const index = local_bindings.findIndex((binding) => binding.scope.root === root);
    const reversed = reverseBinding(
      `repository binding ${root}`,
      prior,
      after,
      local_bindings[index],
    );
    if (equal(prior, after)) continue;
    if (
      reversed &&
      (reversed.entries.length ||
        prior ||
        Object.keys(reversed.invocation_policies ?? {}).length ||
        hasAdditionalFields(reversed))
    ) {
      const binding: RepositoryBinding = {
        ...reversed,
        scope: { ...reversed.scope, kind: "repository", root },
      };
      if (index >= 0) local_bindings[index] = binding;
      else local_bindings.push(binding);
    } else if (index >= 0) local_bindings.splice(index, 1);
  }
  let device = state.device_skill_selection ?? null;
  if (before.device?.mode === "choose" && expected.device?.mode === "choose") {
    if (device?.mode !== "choose") {
      if (!equal(before.device, expected.device)) conflicts.push("device binding selection mode");
    } else {
      const reversed = reverseBinding(
        "device binding",
        before.device.binding,
        expected.device.binding,
        device.binding,
      );
      device = {
        mode: "choose",
        binding: { ...(reversed ?? device.binding), scope: { kind: "global" } },
      };
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
  const { device_skill_selection: _device, ...rest } = state;
  const next: LibraryState = {
    ...rest,
    global_bindings,
    local_bindings,
    skills,
    acquisitions: selectedSourceState.acquisitions,
    ...(device === null ? {} : { device_skill_selection: device }),
  };
  // Per-Skill inverses alone cannot restore a followed Collection's members. Verify the
  // resulting membership after any separately verified source observations were composed.
  const priorBindings = [
    ...before.global,
    ...before.repositories,
    ...(before.device?.mode === "choose" ? [before.device.binding] : []),
  ];
  const currentBindings = [
    ...next.global_bindings,
    ...next.local_bindings,
    ...(next.device_skill_selection?.mode === "choose"
      ? [next.device_skill_selection.binding]
      : []),
  ];
  for (const prior of before.memberships ?? []) {
    const after = expected.memberships?.find((item) => item.collectionId === prior.collectionId);
    if (!after || equal(prior, after)) continue;
    const follows = (bindings: typeof priorBindings) =>
      bindings.some((binding) =>
        binding.entries.some(
          (entry) => entry.kind === "collection" && entry.collection_id === prior.collectionId,
        ),
      );
    const currentMembers = currentCollectionSkills(next, prior.collectionId)
      .map((skill) => skill.skill_id)
      .sort();
    if (
      follows(priorBindings) &&
      follows(currentBindings) &&
      !equal(currentMembers, prior.skillIds)
    )
      conflicts.push(
        `Collection source membership ${prior.collectionId} requires restoration before undo`,
      );
  }
  return { state: next, conflicts, changed: !equal(state, next) };
};

/** A later repository decision is independent of the paths setup touched. Identity stays local. */
export const reverseSetupDiscovery = (
  settings: MachineSettingsSnapshot,
  before: SetupDiscoverySettings,
  expected: SetupDiscoverySettings,
) => {
  const conflicts: string[] = [];
  const restore = <A>(label: string, prior: A, after: A, current: A): A => {
    if (equal(prior, after) || equal(current, prior)) return current;
    if (equal(current, after)) return prior;
    conflicts.push(label);
    return current;
  };
  const discoveryRoots = restore(
    "discovery roots",
    before.discoveryRoots,
    expected.discoveryRoots,
    settings.discoveryRoots,
  );
  const repositories = new Map(settings.repositories.map((item) => [item.path, item.status]));
  const old = new Map(before.repositories.map((item) => [item.path, item.status]));
  const after = new Map(expected.repositories.map((item) => [item.path, item.status]));
  for (const path of new Set([...old.keys(), ...after.keys()])) {
    const status = restore(
      `repository decision ${path}`,
      old.get(path),
      after.get(path),
      repositories.get(path),
    );
    if (status === undefined) repositories.delete(path);
    else repositories.set(path, status);
  }
  const initialized = [...repositories.keys()].some((path) => !old.has(path) && !after.has(path))
    ? settings.repositoryDecisionsInitialized
    : restore(
        "repository discovery initialization",
        before.initialized,
        expected.initialized,
        settings.repositoryDecisionsInitialized,
      );
  // A newly created identity's default name is provenance, not a prior user setting to erase.
  const displayName =
    before.displayName === null
      ? settings.displayName
      : restore(
          "machine display name",
          before.displayName,
          expected.displayName,
          settings.displayName ?? null,
        );
  const next = {
    ...settings,
    discoveryRoots: [...discoveryRoots],
    repositories: [...repositories]
      .map(([path, status]) => ({ path, status }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    repositoryDecisionsInitialized: initialized,
    ...(displayName === null || displayName === undefined ? {} : { displayName }),
  };
  return {
    settings: next,
    conflicts,
    changed: !equal(setupDiscoverySettings(settings), setupDiscoverySettings(next)),
  };
};
