import type { ContractDataForId } from "../commands/output-contracts.js";

export function renderLibraryList(data: ContractDataForId<"skit.list.v3">): string {
  if (data.subjects.length === 0) return "No retained Skills in this Library.";
  const lines: string[] = [];
  for (const subject of data.subjects) {
    lines.push(subject.label);
    const versions = subject.skills.reduce((count, skill) => count + skill.versions.length, 0);
    const unresolved = subject.skills.filter(
      (skill) => skill.selected_skill_version_id === undefined,
    ).length;
    lines.push(
      `  ${subject.skills.length} Skill${subject.skills.length === 1 ? "" : "s"} · ${versions} Skill Version${versions === 1 ? "" : "s"}${unresolved === 0 ? "" : ` · ${unresolved} unresolved`}`,
    );
    for (const skill of subject.skills) lines.push(`    ${skill.name}`);
  }
  for (const binding of data.bindings)
    lines.push(`${binding.harness}: ${binding.skills.join(", ") || "no Skills"}`);
  return lines.join("\n");
}
