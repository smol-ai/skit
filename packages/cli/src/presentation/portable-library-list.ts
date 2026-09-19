import type { ContractDataForId } from "../commands/output-contracts.js";

export function renderPortableLibraryList(data: ContractDataForId<"skit.list.v2">): string {
  if (data.collections.length === 0) return "No retained Collections in this Library.";
  const lines: string[] = [];
  for (const collection of data.collections) {
    lines.push(collection.display_id);
    const versions = collection.skills.reduce((count, skill) => count + skill.versions.length, 0);
    const unresolved = collection.skills.filter(
      (skill) => skill.selected_skill_version_id === undefined,
    ).length;
    lines.push(
      `  ${collection.skills.length} Skill${collection.skills.length === 1 ? "" : "s"} · ${versions} Skill Version${versions === 1 ? "" : "s"}${unresolved === 0 ? "" : ` · ${unresolved} unresolved`}`,
    );
    for (const skill of collection.skills) lines.push(`    ${skill.name}`);
  }
  for (const binding of data.bindings)
    lines.push(`${binding.harness}: ${binding.skills.join(", ") || "no Skills"}`);
  return lines.join("\n");
}
