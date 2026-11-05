import type { AddResult, AddPreview } from "./output.js";
import { plural, sourceDiagnosticLines } from "../presentation/source.js";

export const renderAdd = (data: AddResult) => {
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

export const renderAddPreview = (data: AddPreview) => {
  const count = data.skills.length;
  return [
    `${count} ${count === 1 ? "skill" : "skills"}`,
    "",
    ...data.skills.map((skill) => `  ${skill.name}`),
    ...sourceDiagnosticLines(data.diagnostics),
  ].join("\n");
};
