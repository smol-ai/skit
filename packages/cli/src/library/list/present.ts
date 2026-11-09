import { createColors } from "picocolors";
import { skillMetadataLines, metadataSource } from "../presentation/skill-metadata.js";
import type { ListResult } from "./output.js";
import {
  collectionTitle,
  collectionDetails,
  collectionEnablement,
} from "../presentation/collection-source.js";

export function renderLibraryList(data: ListResult, color = createColors(false)): string {
  if (data.subjects.length === 0) return "No retained Skills in this Library.";
  const lines: string[] = [];
  for (const subject of data.subjects) {
    if (lines.length) lines.push("");
    lines.push(color.cyan(color.bold(collectionTitle(subject.label, subject.collection_source))));
    lines.push(...collectionDetails(subject.collection_source).map((line) => `  ${line}`));
    const versions = subject.skills.reduce((count, skill) => count + skill.versions.length, 0);
    const unresolved = subject.skills.filter(
      (skill) => skill.selected_skill_version_id === undefined,
    ).length;
    lines.push(
      `  ${subject.skills.length} Skill${subject.skills.length === 1 ? "" : "s"} | ${versions} Skill Version${versions === 1 ? "" : "s"}${unresolved === 0 ? "" : ` | ${unresolved} unresolved`} | ${collectionEnablement(subject.skills.length, subject.skills.filter((skill) => (subject.enabled_skills ?? data.enabled_skills).includes(skill.skill_id)).length)}`,
    );
    if (subject.scopes?.length)
      lines.push(
        `  Enabled at: ${subject.scopes.map((scope) => (scope.kind === "global" ? "global" : metadataSource(scope.root))).join(", ")}`,
      );
    for (const skill of subject.skills)
      lines.push(
        `    ${color.bold(skill.name)}`,
        ...skillMetadataLines(skill).map((line) => color.dim(`      ${line}`)),
      );
  }
  if (data.enabled.length)
    lines.push(
      `Enabled: ${data.enabled
        .map((item) => {
          const subject = data.subjects.find((subject) =>
            "collection" in item
              ? subject.subject_id === item.collection
              : subject.skills.some((skill) => skill.skill_id === item.skill),
          );
          const identity =
            subject === undefined
              ? undefined
              : collectionTitle(subject.label, subject.collection_source);
          return "collection" in item
            ? `${identity ?? item.label} (whole Collection)`
            : `${item.name}${identity === undefined ? "" : ` (${identity})`}`;
        })
        .join(", ")}`,
    );
  return lines.join("\n");
}
