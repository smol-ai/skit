import type { ContractDataForId } from "../commands/output-contracts.js";
import { harnessLabel } from "../harness/catalog.js";

type SyncData = ContractDataForId<"skit.library.sync.v5">;
type SyncPlan = NonNullable<SyncData["plan"]>;

/** Name a few Skills; past that, count them so a large Collection stays readable. */
const skillLine = (marker: string, names: readonly string[]) =>
  names.length === 0
    ? []
    : [
        names.length <= 5
          ? `        ${marker} ${names.join(", ")}`
          : `        ${marker} ${names.length} Skills`,
      ];

export function renderLibrarySyncPlan(plan: SyncPlan): string {
  // Collections that differ only in fetch records change nothing a person chose or uses.
  const shown = (changes: SyncPlan["local"]) =>
    changes.filter((change) => change.kind !== "collection" || !change.evidence_only);
  const lines = ["Library sync plan"];
  for (const [title, changes] of [
    ["This device", shown(plan.local)],
    ["Remote Library", shown(plan.remote)],
  ] as const) {
    lines.push("", title);
    if (changes.length === 0) lines.push("  No changes.");
    const collections = changes.filter((change) => change.kind === "collection");
    const bindings = changes.filter((change) => change.kind === "binding");
    if (collections.length) lines.push("  Collections");
    for (const change of collections) {
      const marker = { add: "+", update: "~", remove: "-" }[change.action];
      const identity =
        change.label_before && change.label_after && change.label_before !== change.label_after
          ? `${change.label_before} → ${change.label_after}`
          : change.label;
      lines.push(`    ${marker} ${identity}`);
      if (change.action === "update")
        lines.push(
          ...skillLine("+", change.skills_added),
          ...skillLine("~", change.skills_changed),
          ...skillLine("-", change.skills_removed),
        );
      else if (change.action === "add")
        lines.push(
          `        ${change.skills_added.length} Skill${change.skills_added.length === 1 ? "" : "s"}`,
        );
    }
    if (bindings.length) lines.push("  Bindings");
    for (const change of bindings) {
      const marker = { add: "+", update: "~", remove: "-" }[change.action];
      lines.push(`    ${marker} ${harnessLabel(change.harness)}`);
      for (const entry of change.entries_added) lines.push(`        + ${entry.label}`);
      for (const entry of change.entries_removed) lines.push(`        - ${entry.label}`);
    }
  }
  const changes = [...shown(plan.local), ...shown(plan.remote)];
  const summary = (["add", "update", "remove"] as const).flatMap((action) => {
    const count = changes.filter((change) => change.action === action).length;
    return count === 0 ? [] : [`${count} to ${action}`];
  });
  lines.push("", `Plan: ${summary.join(", ") || "no changes"}.`);
  return lines.join("\n");
}

export function renderLibrarySync(data: SyncData): string {
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
            `  ${harnessLabel(binding.harness)} (global)\n    Skills: ${binding.skills.join(", ") || "none"}\n    Harness unavailable here. Binding kept; local files unchanged.`,
        )
        .join("\n")}`
    : data.deferred
      ? `\n${data.deferred} Binding${data.deferred === 1 ? "" : "s"} deferred on this device.`
      : "";
  const retired = data.retired
    ? `\nRetired ${data.retired} obsolete owned Projection${data.retired === 1 ? "" : "s"}.`
    : "";
  const plan = data.plan ? `${renderLibrarySyncPlan(data.plan)}\n\n` : "";
  const unapplied = (command: string) =>
    `${plan}${deferred.replace(/^\n+/, "")}${deferred ? "\n\n" : ""}No changes applied. Run ${command} to apply.`;
  switch (data.status) {
    case "clean":
      return `Library snapshots are current${revision}${retired}${deferred}`;
    case "push_ready":
      return unapplied("skit sync --apply");
    case "pushed":
      return `Saved retained Library bytes${count}${revision}`;
    case "pull_ready":
      return unapplied("skit sync --apply");
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
      return unapplied("skit sync --adopt --apply");
    case "merge_ready":
      return unapplied("skit sync --apply");
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
