import { bg, bold, fg, StyledText, type TextChunk } from "@opentui/core";

export const ink = {
  strong: "#ffffff",
  DEFAULT: "#d4d4d8",
  muted: "#a1a1aa",
  faint: "#71717a",
  inverse: "#09090b",
} as const;

export const tone = {
  accent: "#38bdf8",
  accentSoft: "#7dd3fc",
  warning: "#fbbf24",
  danger: "#f87171",
  success: "#34d399",
} as const;

export const surface = {
  canvas: "#09090b",
  hairline: "#27272a",
} as const;

export const chip = (label: string, color: string): TextChunk =>
  bg(color)(fg(ink.inverse)(bold(` ${label} `)));

export const sep = (): TextChunk => fg(surface.hairline)("  //  ");

export const panelTitle = (n: number, name: string): string =>
  ` ${String(n).padStart(2, "0")} ${name.toUpperCase()} `;

export const panelColors = (focused: boolean) => ({
  borderColor: focused ? tone.accent : surface.hairline,
  titleColor: focused ? tone.accent : ink.faint,
});

export const listColors = (focused: boolean) => ({
  selectedBackgroundColor: focused ? tone.accent : surface.hairline,
  selectedTextColor: focused ? ink.inverse : ink.DEFAULT,
  selectedDescriptionColor: focused ? ink.inverse : ink.faint,
});

export function keybar(pairs: [key: string, label: string][]): StyledText {
  const chunks: TextChunk[] = [];
  for (const [key, label] of pairs) {
    chunks.push(chip(key, tone.accent), fg(ink.faint)(` ${label}   `));
  }
  return new StyledText(chunks);
}

export function kv(label: string, value: string | TextChunk, width = 12): TextChunk[] {
  return [
    fg(ink.muted)(label.padEnd(width)),
    typeof value === "string" ? fg(ink.DEFAULT)(value) : value,
    fg(ink.DEFAULT)("\n"),
  ];
}

export const receipt = (rows: TextChunk[][]): StyledText => new StyledText(rows.flat());
