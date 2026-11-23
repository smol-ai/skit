import type { InvocationPolicies } from "../device-state.js";
import type { LibraryState } from "../library-state.js";
import type { LibraryAuditChange } from "./audit-log.js";
import { currentSkillVersion, enabledSkillIds, type Enabled } from "../library-contracts.js";

interface ScopeList {
  readonly scopeId: string;
  readonly enabled: readonly Enabled[];
  readonly invocation_policies?: InvocationPolicies;
}

/**
 * Each scope's list, keyed as history has always named it (`global`, `repository:<root>`). The
 * global list counts as present while it enables something or carries invocation overrides.
 */
const scopeLists = (
  state: Pick<LibraryState, "enabled" | "invocation_policies" | "repositories">,
): ScopeList[] => [
  ...(state.enabled.length > 0 || Object.keys(state.invocation_policies ?? {}).length > 0
    ? [
        {
          scopeId: "global",
          enabled: state.enabled,
          ...(state.invocation_policies === undefined
            ? {}
            : { invocation_policies: state.invocation_policies }),
        },
      ]
    : []),
  ...state.repositories.map((repository) => ({
    ...repository,
    scopeId: `repository:${repository.root}`,
  })),
];

const byKey = <T>(items: readonly T[], key: (item: T) => string) =>
  new Map(items.map((item) => [key(item), item]));

const hasChange = (
  changes: readonly LibraryAuditChange[],
  entity: LibraryAuditChange["entity"],
  action: string,
) => changes.some((change) => change.entity === entity && change.action === action);

/** Name one committed mutation without making its workflow describe the audit event itself. */
export const classifyLibraryAuditEvent = (
  workflow: string,
  changes: readonly LibraryAuditChange[],
): string => {
  if (workflow === "sync" || workflow === "library sync") return "library.synced";
  if (workflow === "setup" && hasChange(changes, "collection", "added"))
    return hasChange(changes, "binding", "enabled") ? "custody.adopted" : "collection.retained";
  if (workflow === "add") return "collection.retained";
  if (workflow === "pull" || workflow === "update") return "collection.updated";
  if (workflow === "remove") return "collection.removed";
  if (workflow === "inventory" && hasChange(changes, "projection", "suppressed"))
    return "projection.native-deletion-observed";

  for (const [entity, action, type] of [
    ["collection", "removed", "collection.removed"],
    ["collection", "added", "collection.retained"],
    ["skill", "version-selected", "skill.version-selected"],
    ["binding", "enabled", "binding.enabled"],
    ["binding", "disabled", "binding.disabled"],
    ["projection", "suppressed", "projection.native-deletion-observed"],
    ["projection", "projected", "projection.projected"],
    ["projection", "retired", "projection.retired"],
    ["version", "retained", "version.retained"],
  ] as const)
    if (hasChange(changes, entity, action)) return type;

  const primary = changes[0];
  return primary === undefined ? "library.unchanged" : `${primary.entity}.${primary.action}`;
};

/** Entities present on one side only, and pairs present on both, in a stable order. */
const compare = <T>(before: readonly T[], after: readonly T[], key: (item: T) => string) => {
  const prior = byKey(before, key);
  const next = byKey(after, key);
  return {
    added: [...next].filter(([id]) => !prior.has(id)).map(([, item]) => item),
    removed: [...prior].filter(([id]) => !next.has(id)).map(([, item]) => item),
    kept: [...next].flatMap(([id, item]) => {
      const previous = prior.get(id);
      return previous === undefined ? [] : [{ previous, current: item }];
    }),
  };
};

/**
 * What one Library mutation changed, derived from the state on either side of it.
 *
 * History is a function of the two states, so nothing that mutates the Library has to describe
 * its own effect. Imports and retained copies are deliberately not reported: re-fetching an
 * unchanged Source records an import without changing anything a person selected, and a new
 * retained copy is already visible as the Skill Version it produced.
 */
export const diffLibraryState = (
  before: LibraryState,
  after: LibraryState,
): readonly LibraryAuditChange[] => {
  const changes: LibraryAuditChange[] = [];

  changes.push(...diffCatalogue(before, after));

  changes.push(
    ...diffEnabled(
      before,
      after,
      (list) => enabledSkillIds(before, list),
      (list) => enabledSkillIds(after, list),
    ),
  );

  changes.push(...diffInstalledSkills(before.installed_skills, after.installed_skills));

  return changes;
};

/** The same audit rules apply to direct Installed Skill writes and document imports. */
export const diffInstalledSkills = (
  before: Readonly<LibraryState["installed_skills"]>,
  after: Readonly<LibraryState["installed_skills"]>,
): readonly LibraryAuditChange[] => {
  const changes: LibraryAuditChange[] = [];
  const installedSkills = compare(before, after, (item) => item.installed_skill_id);
  for (const item of installedSkills.added)
    changes.push({
      entity: "projection",
      id: item.installed_skill_id,
      action: "projected",
      after: item.status,
      path: item.path,
      digest: item.expected_hash,
    });
  for (const item of installedSkills.removed)
    changes.push({
      entity: "projection",
      id: item.installed_skill_id,
      action: "retired",
      before: item.status,
      path: item.path,
    });
  for (const { previous, current } of installedSkills.kept) {
    if (
      previous.status === current.status &&
      previous.skill_version_id === current.skill_version_id
    )
      continue;
    changes.push({
      entity: "projection",
      id: current.installed_skill_id,
      action: previous.status === current.status ? "reprojected" : current.status,
      before: previous.status,
      after: current.status,
      path: current.path,
      ...(current.status === "conflicted" ? { digest: current.current_hash } : {}),
    });
  }

  return changes;
};

/** Selection writes and document imports use exactly the same audit contract. */
export const diffEnabled = (
  before: Pick<LibraryState, "enabled" | "invocation_policies" | "repositories">,
  after: Pick<LibraryState, "enabled" | "invocation_policies" | "repositories">,
  beforeSkills: (list: readonly Enabled[]) => readonly string[],
  afterSkills: (list: readonly Enabled[]) => readonly string[],
): readonly LibraryAuditChange[] => {
  const changes: LibraryAuditChange[] = [];
  const lists = compare(scopeLists(before), scopeLists(after), (list) => list.scopeId);
  for (const item of lists.added)
    changes.push({
      entity: "binding",
      id: item.scopeId,
      action: "enabled",
      after: afterSkills(item.enabled).join(","),
    });
  for (const item of lists.removed)
    changes.push({
      entity: "binding",
      id: item.scopeId,
      action: "disabled",
      before: beforeSkills(item.enabled).join(","),
    });
  for (const { previous, current } of lists.kept) {
    const was = [...beforeSkills(previous.enabled)].sort().join(",");
    const now = [...afterSkills(current.enabled)].sort().join(",");
    const previousPolicies = Object.entries(previous.invocation_policies ?? {});
    const currentPolicies = new Map(Object.entries(current.invocation_policies ?? {}));
    const policyChanged =
      previousPolicies.length !== currentPolicies.size ||
      previousPolicies.some(([skillId, value]) => currentPolicies.get(skillId) !== value);
    if (was !== now)
      changes.push({
        entity: "binding",
        id: current.scopeId,
        action: "skills-changed",
        before: was,
        after: now,
      });
    else if (policyChanged)
      changes.push({ entity: "binding", id: current.scopeId, action: "invocation-changed" });
  }

  return changes;
};

type Catalogue = Pick<LibraryState, "collections" | "skills" | "collection_versions" | "imports">;

/** The catalogue owner and document imports share the released audit vocabulary. */
export const diffCatalogue = (
  before: Catalogue,
  after: Catalogue,
): readonly LibraryAuditChange[] => {
  const changes: LibraryAuditChange[] = [];
  const collections = compare(before.collections, after.collections, (item) => item.collection_id);
  for (const item of collections.added)
    changes.push({ entity: "collection", id: item.collection_id, action: "added" });
  for (const item of collections.removed)
    changes.push({ entity: "collection", id: item.collection_id, action: "removed" });

  const selected = (state: Catalogue, skill: LibraryState["skills"][number]) =>
    currentSkillVersion(state, skill)?.skill_version_id;
  const skills = compare(before.skills, after.skills, (item) => item.skill_id);
  for (const item of skills.added) {
    const version = selected(after, item);
    changes.push({
      entity: "skill",
      id: item.skill_id,
      action: "added",
      ...(version === undefined ? {} : { after: version }),
    });
  }
  for (const item of skills.removed)
    changes.push({ entity: "skill", id: item.skill_id, action: "removed" });
  for (const { previous, current } of skills.kept) {
    const versions = compare(previous.versions, current.versions, (item) => item.skill_version_id);
    for (const version of versions.added)
      changes.push({
        entity: "version",
        id: version.skill_version_id,
        action: "retained",
        digest: version.source_hash,
      });
    for (const version of versions.removed)
      changes.push({ entity: "version", id: version.skill_version_id, action: "removed" });
    const was = selected(before, previous);
    const now = selected(after, current);
    if (was !== now)
      changes.push({
        entity: "skill",
        id: current.skill_id,
        action: "version-selected",
        ...(was === undefined ? {} : { before: was }),
        ...(now === undefined ? {} : { after: now }),
      });
  }

  return changes;
};
