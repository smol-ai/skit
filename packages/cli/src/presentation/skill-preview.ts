import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import { terminalColors } from "./terminal-style.js";

/** Clip terminal cells, preserving ANSI colors and wide Unicode characters. */
export const fitTerminalLine = (line: string, width: number): string =>
  stringWidth(line) <= width ? line : `${sliceAnsi(line, 0, Math.max(0, width - 1))}…`;

const previewLines = (text: string, width: number): string[] => {
  const safe = text
    .replace(/\r\n/g, "\n")
    // oxlint-disable-next-line no-control-regex -- File contents must not inject terminal commands.
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\t/g, "  ");
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return safe.split("\n").flatMap((line) => {
    const lines: string[] = [];
    let current = "";
    let cells = 0;
    for (const { segment } of segments.segment(line)) {
      const size = stringWidth(segment);
      if (cells + size > width && current) {
        lines.push(current);
        current = "";
        cells = 0;
      }
      current += segment;
      cells += size;
    }
    lines.push(current);
    return lines;
  });
};

export const renderSkillPreview = (input: {
  picker: readonly string[];
  title: string;
  content: string;
  columns: number;
  rows: number;
  offset: number;
}): { lines: string[]; offset: number; pageSize: number } => {
  const color = terminalColors();
  const columns = Math.max(20, input.columns || 80);
  const height = Math.max(6, Math.min(22, (input.rows || 24) - 2));
  const split = columns >= 110;
  const leftWidth = split ? Math.floor((columns - 3) * 0.46) : columns;
  const rightWidth = split ? columns - leftWidth - 3 : columns;
  const pickerHeight = split ? height : Math.max(2, Math.floor((height - 1) * 0.4));
  const paneHeight = split ? height : height - pickerHeight - 1;
  const pageSize = Math.max(1, paneHeight - 2);
  const content = previewLines(input.content, rightWidth);
  const offset = Math.min(Math.max(0, input.offset), Math.max(0, content.length - pageSize));
  const pane = [
    color.cyan(color.bold(fitTerminalLine(`SKILL.md · ${input.title}`, rightWidth))),
    ...content
      .slice(offset, offset + pageSize)
      .map((line) => (/^#{1,6}\s/.test(line) ? color.bold(line) : line)),
  ];
  while (pane.length < paneHeight - 1) pane.push("");
  pane.push(
    color.dim(
      fitTerminalLine(
        `Lines ${offset + 1}–${Math.min(content.length, offset + pageSize)}/${content.length} · PgUp/PgDn scroll · Ctrl+P close`,
        rightWidth,
      ),
    ),
  );
  const picker = input.picker
    .slice(0, pickerHeight)
    .map((line) => fitTerminalLine(line, leftWidth));
  if (!split)
    return { lines: [...picker, color.dim("─".repeat(columns)), ...pane], offset, pageSize };
  const lines = Array.from({ length: height }, (_, index) => {
    const left = picker[index] ?? "";
    return `${left}${" ".repeat(Math.max(0, leftWidth - stringWidth(left)))} ${color.dim("│")} ${pane[index] ?? ""}`;
  });
  return { lines, offset, pageSize };
};
