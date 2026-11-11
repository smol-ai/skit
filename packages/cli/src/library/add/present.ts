import { Block } from "../../terminal/blocks.js";
import type { AddResult, AddPreview } from "./output.js";
import { plural, sourceDiagnostics } from "../presentation/source.js";

export const renderAdd = (data: AddResult): Block[] => {
  const count = data.skills.length;
  const noun = plural(count, "skill");
  return [
    data.action === "updated"
      ? Block.Status({ tone: "ok", text: [`Updated ${noun} in your Library.`] })
      : data.action === "unchanged"
        ? Block.Status({
            tone: "info",
            text: [`${noun} already ${count === 1 ? "has" : "have"} the current version.`],
          })
        : Block.Status({ tone: "ok", text: [`Added ${noun} to your Library.`] }),
    ...sourceDiagnostics(data.diagnostics),
  ];
};

export const renderAddPreview = (data: AddPreview): Block[] => [
  Block.Changes({
    title: plural(data.skills.length, "skill"),
    items: data.skills.map((skill) => ({ action: "add", label: skill.name })),
  }),
  ...sourceDiagnostics(data.diagnostics),
];
