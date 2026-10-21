import { createColors } from "picocolors";
import type { ContractDataForId } from "../commands/output-contracts.js";

type SyncData = ContractDataForId<"skit.library.sync.v10">;
type SyncPlan = NonNullable<SyncData["plan"]>;

const visibleChanges = (changes: SyncPlan["local"]) =>
  changes.filter((change) => change.kind !== "collection" || !change.evidence_only);

const changeCounts = (changes: SyncPlan["local"], applied = false) => {
  const counts = (["add", "update", "remove"] as const).flatMap((action) => {
    const count = visibleChanges(changes).filter((change) => change.action === action).length;
    const verb = applied
      ? { add: "added", update: "updated", remove: "removed" }[action]
      : `to ${action}`;
    return count === 0 ? [] : [`${count} ${verb}`];
  });
  return counts.join(", ") || "no changes";
};

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
  const lines = [color.bold("Library sync plan")];
  for (const [title, changes] of [
    ["This device", visibleChanges(plan.local)],
    ["Remote Library", visibleChanges(plan.remote)],
  ] as const) {
    lines.push("", color.cyan(color.bold(title)));
    if (changes.length === 0) lines.push(color.dim("  No changes."));
    const collections = changes.filter((change) => change.kind === "collection");
    const bindings = changes.filter((change) => change.kind === "binding");
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
    if (bindings.length) lines.push("  Bindings");
    for (const change of bindings) {
      const marker = markerFor(change.action);
      lines.push(`    ${marker} Enabled Skills`);
      for (const entry of change.entries_added)
        lines.push(`        ${markerFor("add")} ${entry.label}`);
      for (const entry of change.entries_removed)
        lines.push(`        ${markerFor("remove")} ${entry.label}`);
    }
  }
  lines.push(
    "",
    `Plan (Collections and Binding groups): this device: ${changeCounts(plan.local)}; remote: ${changeCounts(plan.remote)}.`,
  );
  return lines.join("\n");
}

export function renderLibrarySync(data: SyncData, color = createColors(false)): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  // What syncing did to this device, when it did anything worth knowing.
  const notes = data.retired
    ? [`Removed ${plural(data.retired, "Skill")} no longer enabled from this device.`]
    : [];
  if (data.projection_conflicts?.length) {
    const conflicts = data.projection_conflicts;
    notes.push(
      `${conflicts.length} installed ${conflicts.length === 1 ? "copy" : "copies"} still ${conflicts.length === 1 ? "has" : "have"} local changes and ${conflicts.length === 1 ? "needs" : "need"} review:`,
      ...conflicts.slice(0, 5).map((conflict) => `  ${conflict.skill}: ${conflict.path}`),
      ...(conflicts.length > 5 ? [`  … and ${conflicts.length - 5} more.`] : []),
      "Run `skit doctor` to inspect the copies. SKIT kept their existing files.",
    );
  }
  const withNotes = (message: string) =>
    notes.length ? `${message}\n\n${notes.join("\n")}` : message;
  const plan = data.plan ? `${renderLibrarySyncPlan(data.plan, color)}\n\n` : "";
  const scope =
    "Sync covers your whole Library, including retained versions and enabled-skill settings; it is not limited to one skill.";
  const transfer =
    data.snapshots_to_upload !== undefined && data.snapshots_to_download !== undefined
      ? `\nSaved copies to transfer: ${data.snapshots_to_upload} upload, ${data.snapshots_to_download} download. A saved copy may contain multiple skills or an older version.`
      : data.snapshots === undefined
        ? ""
        : data.status === "push_ready"
          ? `\n${data.snapshots} saved ${data.snapshots === 1 ? "copy" : "copies"} to upload. A saved copy may contain multiple skills or an older version.`
          : data.status === "pull_ready"
            ? `\n${data.snapshots} saved ${data.snapshots === 1 ? "copy" : "copies"} to download. A saved copy may contain multiple skills or an older version.`
            : "";
  const unapplied = (command: string) =>
    `${plan}${scope}${transfer}\nLocally edited installed copies are preserved if they conflict; review any remaining conflicts with skit doctor after applying.\n\n${notes.length ? `${notes.join("\n")}\n\n` : ""}No changes applied. Run ${command} to apply.`;
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
      return withNotes(
        [
          "Library synced.",
          ...(data.snapshots_to_upload === undefined || data.snapshots_to_download === undefined
            ? []
            : [
                `Saved copies transferred: ${data.snapshots_to_upload} uploaded, ${data.snapshots_to_download} downloaded.`,
              ]),
          ...(data.plan
            ? [
                `Collections and Binding groups changed — this device: ${changeCounts(data.plan.local, true)}; remote: ${changeCounts(data.plan.remote, true)}.`,
              ]
            : []),
        ].join("\n"),
      );
    case "local_bytes_changed":
      return "A stored Skill copy on this device changed unexpectedly; sync stopped.";
    case "adoption_required":
      return "This device hasn't synced with this Library before. Review what would change with skit sync --adopt.";
    case "conflicted":
      if (data.conflict_details?.length)
        return `Library sync stopped:\n${data.conflict_details.map((detail) => `  ${detail.key}\n    ${detail.message}`).join("\n")}\n\nNo sync changes applied.`;
      return `This device and the remote Library changed the same things:\n${data.conflicts?.map((key) => `  ${key}`).join("\n") ?? "  unknown conflict"}\n\nKeep the remote version with skit sync --apply --take-remote <key>.`;
    case "base_mismatch":
      return "This device last synced with a different Library; sync stopped. Run sync --adopt to merge with this Library without inferring deletions.";
    case "resolution_invalid":
      return "The requested resolution isn't available. Use --take-remote for a listed resolvable conflict, or --keep-enabled for one Skill in a listed destination collision.";
    case "enablement_incomplete":
      return withNotes(
        `Library synced, but enablement is incomplete:\n${data.enablement_issues?.map((issue) => `  ${issue}`).join("\n") ?? "  Inspect the selected Skills."}\n\nResolve the listed issues, then run skit sync --apply again.`,
      );
  }
}
