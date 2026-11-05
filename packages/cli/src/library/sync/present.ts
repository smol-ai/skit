import { createColors } from "picocolors";
import type { SyncResult } from "./output.js";

type SyncData = SyncResult;
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

export function renderLibrarySyncPlan(plan: SyncPlan, color = createColors(false)): string {
  const markerFor = (action: "add" | "update" | "remove") =>
    ({ add: "+", update: "~", remove: "-" })[action];
  // Collections that differ only in fetch records change nothing a person chose or uses.
  const shown = (changes: SyncPlan["local"]) =>
    changes.filter((change) => change.kind !== "collection" || !change.evidence_only);
  const lines = [color.bold("Library sync plan")];
  if (plan.enabled_resolution)
    lines.push(
      "",
      `Enabled-list clashes resolved using this device's choices: ${plan.enabled_resolution.collections.map((collection) => collection.label).join(", ")}.`,
    );
  for (const [title, changes] of [
    ["This device", shown(plan.local)],
    ["Remote Library", shown(plan.remote)],
  ] as const) {
    lines.push("", color.cyan(color.bold(title)));
    if (changes.length === 0) lines.push(color.dim("  No changes."));
    const collections = changes.filter((change) => change.kind === "collection");
    const enabled = changes.filter((change) => change.kind === "enabled");
    if (collections.length) lines.push("  Collections");
    for (const change of collections) {
      const marker = markerFor(change.action);
      const identity =
        change.label_before && change.label_after && change.label_before !== change.label_after
          ? `${change.label_before} → ${change.label_after}`
          : change.label;
      lines.push(`    ${marker} ${identity}`);
      if (change.action === "update")
        lines.push(
          ...skillLine(markerFor("add"), change.skills_added),
          ...skillLine(markerFor("update"), change.skills_changed),
          ...skillLine(markerFor("remove"), change.skills_removed),
        );
      else if (change.action === "add")
        lines.push(
          `        ${change.skills_added.length} Skill${change.skills_added.length === 1 ? "" : "s"}`,
        );
    }
    if (enabled.length) lines.push("  Enabled");
    for (const change of enabled) {
      const marker = markerFor(change.action);
      lines.push(`    ${marker} Enabled Skills`);
      for (const item of change.items_added)
        lines.push(`        ${markerFor("add")} ${item.label}`);
      for (const item of change.items_removed)
        lines.push(`        ${markerFor("remove")} ${item.label}`);
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

export function renderLibrarySync(data: SyncData, color = createColors(false)): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  // What syncing did to this device, when it did anything worth knowing.
  const notes = [
    ...(data.merge_base === "empty-first-sync"
      ? ["First sync with this Library: merging from an empty base without inferring deletions."]
      : []),
    ...(data.merge_base === "empty-different-library"
      ? [
          "This device last synced with a different Library: merging from an empty base without inferring deletions.",
        ]
      : []),
    ...(data.uninstalled
      ? [`Removed ${plural(data.uninstalled, "Skill")} no longer enabled from this device.`]
      : []),
  ];
  const withNotes = (message: string) =>
    notes.length ? `${message}\n\n${notes.join("\n")}` : message;
  const plan = data.plan ? `${renderLibrarySyncPlan(data.plan, color)}\n\n` : "";
  const unapplied = (command: string) =>
    `${plan}${notes.length ? `${notes.join("\n")}\n\n` : ""}No changes applied. Run ${command} to apply.`;
  switch (data.status) {
    case "clean":
      return withNotes("Library is already in sync.");
    case "push_ready":
    case "pull_ready":
    case "merge_ready":
      return unapplied("skit sync --apply");
    case "pushed":
    case "pulled":
    case "merged":
      return withNotes("Library synced.");
    case "local_bytes_changed":
      return "A stored Skill copy on this device changed unexpectedly; sync stopped.";
    case "conflicted":
      if (data.conflict_details?.length)
        return withNotes(
          `Library sync stopped:\n${data.conflict_details.map((detail) => `  ${detail.key}\n    ${detail.message}`).join("\n")}\n\nNo sync changes applied.`,
        );
      return withNotes(
        `This device and the remote Library changed the same things:\n${data.conflicts?.map((key) => `  ${key}`).join("\n") ?? "  unknown conflict"}\n\nKeep the remote version with skit sync --apply --take-remote <key>.`,
      );
    case "resolution_invalid":
      return "The requested resolution isn't available. Use --take-remote for a listed resolvable conflict, or --keep-enabled for one Skill in a listed destination collision.";
    case "enablement_incomplete":
      return `Library synced, but enablement is incomplete:\n${data.enablement_issues?.map((issue) => `  ${issue}`).join("\n") ?? "  Inspect the selected Skills."}\n\nResolve the listed issues, then run skit sync --apply again.`;
  }
}
