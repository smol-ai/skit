import { expect, test } from "vitest";
import stringWidth from "string-width";
import { renderSkillPreview } from "../src/presentation/skill-preview.js";

const input = {
  picker: ["Pick skills", "Ctrl+P preview", "☒ review"],
  title: "review",
  content: "# Review\n" + "A long line 中文 👩‍💻 ".repeat(20),
  offset: 0,
};
test("wide terminals put preview beside the picker within the terminal bounds", () => {
  const frame = renderSkillPreview({ ...input, columns: 140, rows: 24 });
  expect(frame.lines[0]).toContain("│ SKILL.md · review");
  expect(frame.lines.every((line) => stringWidth(line) <= 140)).toBe(true);
  expect(frame.lines.length).toBeLessThan(24);
});
test("narrow terminals stack preview under the picker and clamp scrolling", () => {
  const frame = renderSkillPreview({ ...input, columns: 60, rows: 20, offset: 9999 });
  expect(frame.lines.join("\n")).toContain("─".repeat(60) + "\nSKILL.md · review");
  expect(frame.lines.every((line) => stringWidth(line) <= 60)).toBe(true);
  expect(frame.offset).toBeLessThan(9999);
  expect(frame.lines.length).toBeLessThan(20);
});
test("content cannot inject terminal commands", () => {
  const frame = renderSkillPreview({
    ...input,
    columns: 120,
    rows: 24,
    content: "before\u001b[2Jafter\u009b31m\u0007",
  });
  expect(frame.lines.join("\n")).not.toContain("\u001b[2J");
  expect(frame.lines.join("\n")).not.toContain("\u009b");
  expect(frame.lines.join("\n")).not.toContain("\u0007");
});
