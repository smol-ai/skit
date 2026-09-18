import type { LibraryState } from "../portable-local-state.js";
import type { LibraryAuditChange } from "./audit-log.js";

type Binding = LibraryState["global_bindings"][number] | LibraryState["local_bindings"][number];

const bindingId = (binding: Binding) =>
  binding.scope.kind === "repository"
    ? `${binding.collection_id}:${binding.harness}:repository:${binding.scope.root}`
    : `${binding.collection_id}:${binding.harness}:${binding.scope.kind}`;

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
  if (workflow === "pin") return "skill.version-selected";
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
 * its own effect. Acquisitions and retained copies are deliberately not reported: re-acquiring an
 * unchanged Source records an Acquisition without changing anything a person selected, and a new
 * retained copy is already visible as the Skill Version it produced.
 */
export const diffLibraryState = (
  before: LibraryState,
  after: LibraryState,
): readonly LibraryAuditChange[] => {
  const changes: LibraryAuditChange[] = [];

  const collections = compare(before.collections, after.collections, (item) => item.collection_id);
  for (const item of collections.added)
    changes.push({ entity: "collection", id: item.collection_id, action: "added" });
  for (const item of collections.removed)
    changes.push({ entity: "collection", id: item.collection_id, action: "removed" });

  const skills = compare(before.skills, after.skills, (item) => item.skill_id);
  for (const item of skills.added)
    changes.push({
      entity: "skill",
      id: item.skill_id,
      action: "added",
      ...(item.selected_skill_version_id === undefined
        ? {}
        : { after: item.selected_skill_version_id }),
    });
  for (const item of skills.removed)
    changes.push({ entity: "skill", id: item.skill_id, action: "removed" });
  for (const { previous, current } of skills.kept) {
    const versions = compare(previous.versions, current.versions, (item) => item.skill_version_id);
    for (const version of versions.added)
      changes.push({
        entity: "version",
        id: version.skill_version_id,
        action: "retained",
        digest: version.source_digest,
      });
    for (const version of versions.removed)
      changes.push({ entity: "version", id: version.skill_version_id, action: "removed" });
    if (previous.selected_skill_version_id !== current.selected_skill_version_id)
      changes.push({
        entity: "skill",
        id: current.skill_id,
        action: "version-selected",
        ...(previous.selected_skill_version_id === undefined
          ? {}
          : { before: previous.selected_skill_version_id }),
        ...(current.selected_skill_version_id === undefined
          ? {}
          : { after: current.selected_skill_version_id }),
      });
  }

  const bindings = compare<Binding>(
    [...before.global_bindings, ...before.local_bindings],
    [...after.global_bindings, ...after.local_bindings],
    bindingId,
  );
  for (const item of bindings.added)
    changes.push({
      entity: "binding",
      id: bindingId(item),
      action: "enabled",
      after: item.skills.join(","),
    });
  for (const item of bindings.removed)
    changes.push({
      entity: "binding",
      id: bindingId(item),
      action: "disabled",
      before: item.skills.join(","),
    });
  for (const { previous, current } of bindings.kept) {
    const was = [...previous.skills].sort().join(",");
    const now = [...current.skills].sort().join(",");
    const policyChanged =
      JSON.stringify(previous.invocation_policies ?? {}) !==
      JSON.stringify(current.invocation_policies ?? {});
    if (was !== now)
      changes.push({
        entity: "binding",
        id: bindingId(current),
        action: "skills-changed",
        before: was,
        after: now,
      });
    else if (policyChanged)
      changes.push({ entity: "binding", id: bindingId(current), action: "invocation-changed" });
  }

  const projections = compare(before.projections, after.projections, (item) => item.projection_id);
  for (const item of projections.added)
    changes.push({
      entity: "projection",
      id: item.projection_id,
      action: "projected",
      after: item.status,
      path: item.path,
      digest: item.expected_digest,
    });
  for (const item of projections.removed)
    changes.push({
      entity: "projection",
      id: item.projection_id,
      action: "retired",
      before: item.status,
      path: item.path,
    });
  for (const { previous, current } of projections.kept) {
    if (
      previous.status === current.status &&
      previous.skill_version_id === current.skill_version_id
    )
      continue;
    changes.push({
      entity: "projection",
      id: current.projection_id,
      action: previous.status === current.status ? "reprojected" : current.status,
      before: previous.status,
      after: current.status,
      path: current.path,
      ...(current.observed_digest === undefined ? {} : { digest: current.observed_digest }),
    });
  }

  return changes;
};
