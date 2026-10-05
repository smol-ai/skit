import { normalizeTerminalPalette, rgbToHex, type TerminalColors } from "@opentui/core";

const isHex = (value: string | null | undefined): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

/** Use detected colours where available, filling missing ANSI slots from OpenTUI's palette. */
export function previewPalette(
  detected: TerminalColors | undefined,
  fallback: { foreground: string; background: string },
): { sequence: string; source: "host" | "mixed" | "fallback" } {
  const foreground = isHex(detected?.defaultForeground)
    ? detected.defaultForeground
    : fallback.foreground;
  const background = isHex(detected?.defaultBackground)
    ? detected.defaultBackground
    : fallback.background;
  const palette = detected?.palette.slice(0, 16) ?? [];
  const complete =
    palette.length === 16 &&
    palette.every(isHex) &&
    isHex(detected?.defaultForeground) &&
    isHex(detected?.defaultBackground);
  const anyDetected =
    palette.some(isHex) || isHex(detected?.defaultForeground) || isHex(detected?.defaultBackground);
  const normalized = normalizeTerminalPalette(detected);
  const sequence =
    normalized.palette
      .slice(0, 16)
      .map(
        (color, index) =>
          `\u001b]4;${index};${isHex(palette[index]) ? palette[index] : rgbToHex(color)}\u0007`,
      )
      .join("") + `\u001b]10;${foreground}\u0007\u001b]11;${background}\u0007`;
  return { sequence, source: complete ? "host" : anyDetected ? "mixed" : "fallback" };
}
