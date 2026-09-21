import type { ContractDataForId } from "../commands/output-contracts.js";

export function renderCheck(data: ContractDataForId<"skit.check.v7">) {
  if (data.length === 0) return "The Library has no retained Library subjects.";
  const lines = data.flatMap((item) => {
    const retainedBytesCurrent = item.retained_copies.every((tree) => tree.retained_bytes_current);
    const members = item.skills_sh?.members ?? [];
    const updates = members.filter((member) => member.status === "update-available").length;
    const problems = members.filter(
      (member) => !["current", "update-available", "not-applicable"].includes(member.status),
    );
    if (
      retainedBytesCurrent &&
      item.unresolved_skill_selections === 0 &&
      item.source_status === "not-applicable" &&
      problems.length === 0
    )
      return [];
    if (
      retainedBytesCurrent &&
      item.unresolved_skill_selections === 0 &&
      ["current", "not-applicable"].includes(item.source_status) &&
      updates === 0 &&
      problems.length === 0
    )
      return [`✔ ${item.label} is up to date`];
    if (retainedBytesCurrent && updates > 0 && problems.length === 0)
      return [
        `↑ ${item.label} has updates available${members.length > 1 ? ` (${updates} of ${members.length} Skills)` : ""}`,
      ];
    if (!retainedBytesCurrent) return [`✖ ${item.label} has damaged retained bytes`];
    if (problems.length)
      return [
        `! ${item.label} needs attention · ${problems.map((member) => `${member.skill_name}: ${member.status}`).join(", ")}`,
      ];
    if (item.source_status === "changed") return [`↑ ${item.label} has updates available`];
    return [`? ${item.label} could not be fully checked`];
  });
  return lines.join("\n");
}
