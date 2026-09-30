import { createColors } from "picocolors";
import { metadataDate, metadataSource, metadataRevision } from "./skill-metadata.js";
import type { ContractDataForId } from "../commands/output-contracts.js";

export function renderLibraryList(
  data: ContractDataForId<"skit.list.v5">,
  color = createColors(false),
): string {
  if (data.subjects.length === 0) return "No retained Skills in this Library.";
  const lines: string[] = [];
  for (const subject of data.subjects) {
    if (lines.length) lines.push("");
    lines.push(color.cyan(color.bold(subject.label)));
    const versions = subject.skills.reduce((count, skill) => count + skill.versions.length, 0);
    const unresolved = subject.skills.filter(
      (skill) => skill.selected_skill_version_id === undefined,
    ).length;
    lines.push(
      `  ${subject.skills.length} Skill${subject.skills.length === 1 ? "" : "s"} · ${versions} Skill Version${versions === 1 ? "" : "s"}${unresolved === 0 ? "" : ` · ${unresolved} unresolved`}`,
    );
    for (const skill of subject.skills)
      lines.push(
        `    ${color.bold(skill.name)} ${color.dim(`· revision ${metadataRevision(skill.revision)}`)}`,
        `      Source: ${metadataSource(skill.source)}`,
        color.dim(
          `      Source updated: ${metadataDate(skill.source_updated_at)} · Acquired: ${metadataDate(skill.acquired_at)}`,
        ),
      );
  }
  for (const binding of data.bindings)
    lines.push(
      `${binding.harness}: ${
        binding.entries
          .map((entry) =>
            entry.kind === "collection" ? `${entry.label} (whole Collection)` : entry.name,
          )
          .join(", ") || "no Skills"
      }`,
    );
  return lines.join("\n");
}
