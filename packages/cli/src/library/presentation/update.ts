import { type ContractData, type ContractDataForId } from "../../commands/output-contracts.js";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const sourceDiagnosticLines = (diagnostics?: readonly { path: string; message: string }[]) =>
  (diagnostics ?? []).map((diagnostic) => `  ! ${diagnostic.path}: ${diagnostic.message}`);

/** One Source's effect on this device: enabled, changed, retired, kept, and available Skills. */
function skillChangeLines(
  item: Pick<
    ContractDataForId<"skit.update.plan.v6">[number],
    "enabled" | "updated" | "removed" | "kept" | "new_available"
  >,
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

export function renderUpdate(data: ContractDataForId<"skit.update.v9">): string {
  if (!data.length) return "No device-local Sources to update";
  const failures = data.filter((item) => "status" in item);
  const successful = data.filter((item) => "changed" in item);
  const updated = successful.filter((item) => item.changed);
  const current = successful.length - updated.length;
  if (updated.length === 0 && failures.length === 0)
    return [
      successful.some((item) => item.installed > 0)
        ? `Sources are current; installed skills updated\n${plural(current, "Source")} checked; no retained snapshots changed.`
        : `Everything is current\n${plural(current, "Source")} checked; no retained snapshots or installed skills changed.`,
      ...successful.flatMap((item) =>
        item.diagnostics?.length ? [item.label, ...sourceDiagnosticLines(item.diagnostics)] : [],
      ),
    ].join("\n");
  const lines = [failures.length ? "Update finished with failures" : "Update complete"];
  for (const item of successful.filter((item) => item.changed || item.diagnostics?.length))
    lines.push(item.label, ...skillChangeLines(item), ...sourceDiagnosticLines(item.diagnostics));
  for (const item of failures)
    lines.push(
      `${item.label} · failed while ${item.phase === "source" ? "fetching or retaining Source" : "updating installed skills"}`,
      `  Source: ${item.source}`,
      ...(item.source_imported
        ? ["  Source snapshot retained; this Collection did not finish updating."]
        : []),
      ...item.error.message.split("\n").map((line) => `  ${line}`),
      `  ${item.error.remediation}`,
    );
  lines.push(
    "",
    `${plural(updated.length, "Source")} updated${current ? `; ${current} already current` : ""}${failures.length ? `; ${failures.length} failed` : ""}.`,
  );
  return lines.join("\n");
}

export function renderUpdatePlan(data: ContractDataForId<"skit.update.plan.v6">): string {
  if (!data.length) return "No device-local Sources to update";
  const lines = ["Update plan"];
  for (const item of data)
    lines.push(
      `${item.label} · ${item.changed ? "update available" : "current"}`,
      ...skillChangeLines(item),
      ...sourceDiagnosticLines(item.diagnostics),
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

export const renderAdd = (data: ContractData<"add">) => {
  const count = data.skills.length;
  const noun = plural(count, "skill");
  const summary =
    data.action === "updated"
      ? `Updated ${noun} in your Library.`
      : data.action === "unchanged"
        ? `${noun} already ${count === 1 ? "has" : "have"} the current retained version.`
        : `Added ${noun} to your Library.`;
  return [summary, ...sourceDiagnosticLines(data.diagnostics)].join("\n");
};

export const renderAddPreview = (data: ContractData<"addPreview">) => {
  const count = data.skills.length;
  return [
    `${count} ${count === 1 ? "skill" : "skills"}`,
    "",
    ...data.skills.map((skill) => `  ${skill.name}`),
    ...sourceDiagnosticLines(data.diagnostics),
  ].join("\n");
};
