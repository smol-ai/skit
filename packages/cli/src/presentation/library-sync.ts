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
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  // What syncing did to this device, when it did anything worth knowing.
  const notes = [
    ...(data.retired
      ? [`Removed ${plural(data.retired, "Skill")} no longer enabled from this device.`]
      : []),
    ...(data.projection_drift?.length
      ? [
          `${plural(data.projection_drift.length, "enabled Skill")} differ from the synced Version: ${data.projection_drift.join(", ")}`,
        ]
      : []),
    ...(data.deferred_bindings?.length
      ? data.deferred_bindings.map(
          (binding) =>
            `${harnessLabel(binding.harness)} isn't available on this device, so these Skills aren't enabled here: ${binding.skills.join(", ") || "none"}`,
        )
      : data.deferred
        ? [
            data.deferred === 1
              ? "An agent isn't available on this device, so its Skills aren't enabled here."
              : `${data.deferred} agents aren't available on this device, so their Skills aren't enabled here.`,
          ]
        : []),
  ];
  const withNotes = (message: string) =>
    notes.length ? `${message}\n\n${notes.join("\n")}` : message;
  const plan = data.plan ? `${renderLibrarySyncPlan(data.plan)}\n\n` : "";
  const unapplied = (command: string) =>
    `${plan}${notes.length ? `${notes.join("\n")}\n\n` : ""}No changes applied. Run ${command} to apply.`;
  switch (data.status) {
    case "clean":
      return withNotes("Library is already in sync.");
    case "push_ready":
    case "pull_ready":
    case "merge_ready":
      return unapplied("skit sync --apply");
    case "adoption_ready":
      return unapplied("skit sync --adopt --apply");
    case "pushed":
    case "pulled":
    case "merged":
    case "upgraded":
      return withNotes("Library synced.");
    case "upgrade_ready":
      return "The remote Library uses an older sync format. Run skit sync --apply to upgrade it.";
    case "legacy_remote_conflict":
      return "The remote Library has changes from an older skit that this device doesn't have; sync stopped.";
    case "local_migration_required":
      return "Update this device's Library before syncing.";
    case "local_bytes_changed":
      return "A stored Skill copy on this device changed unexpectedly; sync stopped.";
    case "adoption_required":
      return "This device hasn't synced with this Library before. Review what would change with skit sync --adopt.";
    case "conflicted":
      return `This device and the remote Library changed the same things:\n${data.conflicts?.map((key) => `  ${key}`).join("\n") ?? "  unknown conflict"}\n\nKeep the remote version with skit sync --apply --take-remote <key>.`;
    case "base_mismatch":
      return "This device last synced with a different Library; sync stopped.";
    case "resolution_invalid":
      return "--take-remote named something that isn't a current conflict.";
  }
}
