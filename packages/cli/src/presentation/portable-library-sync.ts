import type { ContractDataForId } from "../commands/output-contracts.js";
import { harnessLabel } from "../harness/catalog.js";

type SyncData = ContractDataForId<"skit.library.sync.v3">;
type SyncPlan = NonNullable<SyncData["plan"]>;

const skillChange = (before: readonly string[], after: readonly string[]): string => {
  const previous = before.join(", ") || "none";
  const desired = after.join(", ") || "none";
  return previous === desired ? previous : `${previous} → ${desired}`;
};

export function renderPortableLibrarySyncPlan(plan: SyncPlan): string {
  const lines = ["Library sync plan"];
  for (const [title, changes] of [
    ["This device", plan.local],
    ["Remote Library", plan.remote],
  ] as const) {
    lines.push("", title);
    if (changes.length === 0) {
      lines.push("  No changes.");
      continue;
    }
    for (const change of changes) {
      const marker = { add: "+", update: "~", remove: "-" }[change.action];
      if (change.kind === "collection") {
        const identity =
          change.collection_before &&
          change.collection_after &&
          change.collection_before !== change.collection_after
            ? `${change.collection_before} → ${change.collection_after}`
            : change.collection;
        lines.push(`  ${marker} ${change.action} Collection ${identity}`);
        lines.push(`    Skills: ${skillChange(change.skills_before, change.skills_after)}`);
        if (change.versions_before.join("\0") !== change.versions_after.join("\0"))
          lines.push(`    Versions: ${skillChange(change.versions_before, change.versions_after)}`);
        if (change.evidence_changed)
          lines.push("    Retention or acquisition evidence will be updated.");
      } else {
        lines.push(
          `  ${marker} ${change.action} ${change.collection} → ${change.harness ? harnessLabel(change.harness) : "unknown harness"} (global)`,
        );
        lines.push(`    Skills: ${skillChange(change.skills_before, change.skills_after)}`);
      }
    }
  }
  const changes = [...plan.local, ...plan.remote];
  const summary = (["add", "update", "remove"] as const).flatMap((action) => {
    const count = changes.filter((change) => change.action === action).length;
    return count === 0 ? [] : [`${count} to ${action}`];
  });
  lines.push("", `Plan: ${summary.join(", ") || "no Library changes"}.`);
  lines.push("Local files and custody are checked during application.");
  return lines.join("\n");
}

export function renderPortableLibrarySync(data: SyncData): string {
  const count =
    data.snapshots === undefined
      ? ""
      : ` · ${data.snapshots} private snapshot${data.snapshots === 1 ? "" : "s"}`;
  const revision = data.revision_id === undefined ? "" : ` · revision ${data.revision_id}`;
  const drift = data.projection_drift?.length
    ? `\nProjection recipe differs for ${data.projection_drift.length} Version${data.projection_drift.length === 1 ? "" : "s"}: ${data.projection_drift.join(", ")}`
    : "";
  const deferred = data.deferred_bindings?.length
    ? `\n\nDeferred on this device\n${data.deferred_bindings
        .map(
          (binding) =>
            `  ${binding.collection} → ${harnessLabel(binding.harness)} (global)\n    Skills: ${binding.skills.join(", ") || "none"}\n    Harness unavailable here. Binding kept; local files unchanged.`,
        )
        .join("\n")}`
    : data.deferred
      ? `\n${data.deferred} Binding${data.deferred === 1 ? "" : "s"} deferred on this device.`
      : "";
  const retired = data.retired
    ? `\nRetired ${data.retired} obsolete owned Projection${data.retired === 1 ? "" : "s"}.`
    : "";
  const removing = data.collections_to_remove
    ? `\n${data.collections_to_remove} removed Collection${data.collections_to_remove === 1 ? "" : "s"} will retire owned Projections on this device.`
    : "";
  const plan = data.plan ? `${renderPortableLibrarySyncPlan(data.plan)}\n\n` : "";
  switch (data.status) {
    case "clean":
      return `Library snapshots are current${revision}${retired}${deferred}`;
    case "push_ready":
      return `${plan}Ready to save retained Library bytes${count}\n\nNo changes applied. Run skit sync --apply to apply.`;
    case "pushed":
      return `Saved retained Library bytes${count}${revision}`;
    case "pull_ready":
      return `${plan}Ready to restore retained Library bytes${count}${deferred}\n\nNo changes applied. Run skit sync --apply to apply.`;
    case "pulled":
      return `Restored retained Library bytes${count}${revision}${drift}${retired}${deferred}`;
    case "upgrade_ready":
      return `Ready to upgrade the Library's older sync revision${count}\nRun skit sync --apply to apply.`;
    case "upgraded":
      return `Upgraded the Library sync revision${count}${revision}`;
    case "legacy_remote_conflict":
      return `The older remote Library has intent not accounted for locally${revision}`;
    case "local_migration_required":
      return "Migrate the local Library before syncing retained bytes.";
    case "local_bytes_changed":
      return `Retained local bytes changed for ${data.digest ?? "a Version"}; sync stopped.`;
    case "adoption_required":
      return `This device has no accepted base for the remote Library${revision}. Review adoption with skit sync --adopt.`;
    case "adoption_ready":
      return `${plan}Ready to adopt independent local and remote Collections${count}${revision}${deferred}\n\nNo changes applied. Run skit sync --adopt --apply to apply.`;
    case "merge_ready":
      return `${plan}Ready to reconcile local and remote Collections${count}${revision}${removing}${deferred}\n\nNo changes applied. Run skit sync --apply to apply.`;
    case "merged":
      return `Reconciled Library Collections${count}${revision}${drift}${retired}${deferred}`;
    case "conflicted":
      return `Library changes conflict${revision}:\n${data.conflicts?.map((key) => `  ${key}`).join("\n") ?? "  unknown conflict"}`;
    case "base_mismatch":
      return `The accepted Library base belongs to another Registry or Library${revision}.`;
    case "resolution_invalid":
      return `A --take-remote key does not name a current Collection or Binding conflict${revision}.`;
  }
}
