import { createColors } from "picocolors";
import type { Choice } from "./prompter.js";
import { terminalText } from "./text.js";

/** A static preview of an offered question; the live prompt still owns input and selection. */
export function renderPromptSnapshot(
  message: string,
  choices: readonly Choice<string>[],
  colors: boolean,
): string {
  const color = createColors(colors);
  return [
    `${color.cyan("?")} ${color.bold(terminalText(message))}`,
    ...choices.map((choice, index) => {
      const label = terminalText(choice.label);
      return `  ${index === 0 ? color.cyan("❯") : " "} ${choice.selected && !choice.disabled ? color.green("☒") : color.dim("☐")} ${choice.disabled ? color.dim(label) : index === 0 ? color.bold(label) : label}${choice.hint ? color.dim(` | ${terminalText(choice.hint)}`) : ""}`;
    }),
  ].join("\n");
}
