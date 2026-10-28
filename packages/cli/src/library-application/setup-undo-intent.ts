import { Schema } from "effect";
import {
  canonicalJson,
  ImportId,
  CollectionId,
  currentCollectionSkills,
  currentSkillVersion,
  DeviceBindingV9,
  DeviceSkillSelection,
  DeviceSkillSelectionV9,
  deviceSelectionFromV9,
  Enabled,
  globalFromV9,
  InvocationPolicies,
  Repository,
  RepositoryBindingV9,
  repositoryFromV9,
  CollectionVersionId,
  SkillId,
  SkillVersionId,
  CurrentMachineDocument,
  sourceImports,
  type LibraryState,
  type Import,
  type MachineSettingsSnapshot,
} from "@smolai/skit-core";

const Memberships = Schema.optionalKey(
  Schema.Array(
    Schema.Struct({
      collectionId: CollectionId,
      skillIds: Schema.Array(SkillId),
    }),
  ),
);
const Versions = Schema.Array(
  Schema.Struct({
    skillId: SkillId,
    selected: Schema.NullOr(SkillVersionId),
    local: Schema.NullOr(SkillVersionId),
  }),
);

/** The desired fields setup can change. Retained artifacts and audit history are not inverse data. */
export const SetupIntent = Schema.Struct({
  /** The account's global list. */
  global: Schema.Struct({
    enabled: Schema.Array(Enabled),
    invocation_policies: Schema.optionalKey(InvocationPolicies),
  }),
  repositories: Schema.Array(Repository),
  device: Schema.NullOr(DeviceSkillSelection),
  sources: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        collectionId: CollectionId,
        importId: ImportId,
        collectionVersionId: CollectionVersionId,
      }),
    ),
  ),
  memberships: Memberships,
  versions: Versions,
});
export type SetupIntent = typeof SetupIntent.Type;

/** Frozen v1 intent, as setup records written beside v9 Library state hold it. */
export const SetupIntentV1 = Schema.Struct({
  global: Schema.Array(DeviceBindingV9),
  repositories: Schema.Array(RepositoryBindingV9),
  device: Schema.NullOr(DeviceSkillSelectionV9),
  sources: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        collectionId: CollectionId,
        acquisitionId: ImportId,
        retainedCopyId: CollectionVersionId,
      }),
    ),
  ),
  memberships: Memberships,
  versions: Versions,
});

/** The v2 intent a v1 record means: the same lists in the shapes v10 state holds them. */
export const setupIntentFromV1 = ({
  global,
  repositories,
  device,
  sources,
  ...fields
}: typeof SetupIntentV1.Type): SetupIntent => ({
  ...fields,
  global: globalFromV9(global[0]),
  repositories: repositories.map(repositoryFromV9),
  device: device === null ? null : deviceSelectionFromV9(device),
  ...(sources === undefined
    ? {}
    : {
        sources: sources.map(({ collectionId, acquisitionId, retainedCopyId }) => ({
          collectionId,
          importId: acquisitionId,
          collectionVersionId: retainedCopyId,
        })),
      }),
});

const withPolicies = (invocation_policies: InvocationPolicies | undefined) =>
  invocation_policies === undefined ? {} : { invocation_policies };

export const setupIntent = (state: LibraryState): SetupIntent => ({
  global: { enabled: [...state.enabled], ...withPolicies(state.invocation_policies) },
  repositories: structuredClone(state.repositories),
  device: structuredClone(state.device_skill_selection ?? null),
  sources: state.collections
    .flatMap((collection) => {
      const selected = sourceImports(state, collection.collection_id)[0];
      return selected
        ? [
            {
              collectionId: collection.collection_id,
              importId: selected.import_id,
              collectionVersionId: selected.collection_version_id,
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
