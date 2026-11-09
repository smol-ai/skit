import type { UpdatePlan, UpdateResult } from "./output.js";
import { plural, sourceDiagnosticLines } from "../presentation/source.js";

/** One Source's effect on this device: enabled, changed, retired, kept, and available Skills. */
function skillChangeLines(
  item: Pick<UpdatePlan[number], "enabled" | "updated" | "removed" | "kept" | "new_available">,
): string[] {
  return [
    ...item.enabled.map((name) => `  + ${name}`),
    ...item.updated.map((name) => `  ~ ${name}`),
    ...item.removed.map((name) => `  - ${name}`),
    ...item.kept.map(
      (name) => `  ! ${name} was deleted upstream; kept because it is enabled on its own`,
    ),
    ...(item.new_available
      ? [`  ${plural(item.new_available, "new Skill")} available to enable`]
      : []),
  ];
}

export function renderUpdate(data: UpdateResult): string {
  if (!data.length) return "No device-local Sources to update";
  const failures = data.filter((item) => "status" in item);
  const successful = data.filter((item) => "changed" in item);
  const updated = successful.filter((item) => item.changed);
  const current = successful.length - updated.length;
  const syncFailed = successful.some((item) => item.sync_error !== undefined);
  const authorMessages = successful.flatMap((item) => [
    ...(item.messages ?? []).map((message) => `${item.label}: ${message}`),
    ...(item.sync_error === undefined
      ? []
      : [
          `${item.label}: local update completed; Registry sync failed: ${item.sync_error.message}`,
          `  ${item.sync_error.remediation}`,
        ]),
    ...(item.sync_status === "blocked" || item.sync_status === "waiting_for_removal"
      ? [
          `${item.label}: Registry sync ${item.sync_status === "blocked" ? "paused for removal approval" : "waiting for removal confirmation"}`,
        ]
      : []),
  ]);
  if (updated.length === 0 && failures.length === 0)
    return [
      syncFailed
        ? "Local updates complete; Registry sync failed"
        : successful.some((item) => item.installed > 0)
          ? `Sources are current; installed skills updated\n${plural(current, "Source")} checked; no retained snapshots changed.`
          : `Everything is current\n${plural(current, "Source")} checked; no retained snapshots or installed skills changed.`,
      ...successful.flatMap((item) =>
        item.diagnostics?.length ? [item.label, ...sourceDiagnosticLines(item.diagnostics)] : [],
      ),
      ...authorMessages,
    ].join("\n");
  const lines = [
    failures.length
      ? "Update finished with failures"
      : syncFailed
        ? "Local updates complete; Registry sync failed"
        : "Update complete",
  ];
  for (const item of successful.filter((item) => item.changed || item.diagnostics?.length))
    lines.push(item.label, ...skillChangeLines(item), ...sourceDiagnosticLines(item.diagnostics));
  for (const item of failures)
    lines.push(
      `${item.label} | failed while ${item.phase === "source" ? "fetching or retaining Source" : "updating installed skills"}`,
      `  Source: ${item.source}`,
      ...(item.source_imported
        ? ["  Source snapshot retained; this Collection did not finish updating."]
        : []),
      ...item.error.message.split("\n").map((line) => `  ${line}`),
      `  ${item.error.remediation}`,
      ...(item.source_imported ? [`  Run \`skit update ${item.subject_id}\` to retry it.`] : []),
    );
  lines.push(
    ...authorMessages,
    "",
    `${plural(updated.length, "Source")} updated${current ? `; ${current} already current` : ""}${failures.length ? `; ${failures.length} failed` : ""}.`,
  );
  return lines.join("\n");
}

export function renderUpdatePlan(data: UpdatePlan): string {
  if (!data.length) return "No device-local Sources to update";
  const lines = ["Update plan"];
  for (const item of data)
    lines.push(
      `${item.label} | ${item.changed ? "update available" : "current"}`,
      ...skillChangeLines(item),
      ...sourceDiagnosticLines(item.diagnostics),
      ...(item.messages ?? []).map((message) => `  ${message}`),
    );
  const updates = data.filter((item) => item.changed).length;
  lines.push(
    "",
    updates
      ? `${plural(updates, "Source")} can be updated. No changes applied; run \`skit update\` to apply.`
      : "Everything is current.",
  );
  return lines.join("\n");
}
