import type { TerminalColors } from "@opentui/core";

const isHex = (value: string | null | undefined): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

/** OSC overrides keep the embedded terminal from substituting its own ANSI palette. */
export function previewPalette(
  detected: TerminalColors | undefined,
  fallback: { foreground: string; background: string },
): { sequence: string; colorAvailable: boolean } {
  const foreground = isHex(detected?.defaultForeground)
    ? detected.defaultForeground
    : fallback.foreground;
  const background = isHex(detected?.defaultBackground)
    ? detected.defaultBackground
    : fallback.background;
  const palette = detected?.palette.slice(0, 16) ?? [];
  const colorAvailable =
    palette.length === 16 &&
    palette.every(isHex) &&
    isHex(detected?.defaultForeground) &&
    isHex(detected?.defaultBackground);
  const sequence =
    palette
      .flatMap((color, index) => (isHex(color) ? [`\u001b]4;${index};${color}\u0007`] : []))
      .join("") + `\u001b]10;${foreground}\u0007\u001b]11;${background}\u0007`;
  return { sequence, colorAvailable };
}
