import stringWidth from "string-width";
import { terminalText } from "./text.js";

/** Static context inside a selection prompt. Scale stays fixed while selected savings change. */
export function renderBudgetMeter(
  meter: {
    readonly label: string;
    readonly demand: number;
    readonly originalDemand: number;
    readonly limit: number;
    readonly unit: string;
  },
  columns: number,
): string {
  const width = Math.max(8, Math.min(24, columns - 64));
  const scale = Math.max(meter.originalDemand, meter.limit, 1);
  const limitCells = Math.round((meter.limit / scale) * width);
  const filled = Math.min(width, Math.round((meter.demand / scale) * width));
  const bar = Array.from({ length: width }, (_, index) =>
    index >= filled ? "░" : index < limitCells ? "█" : "▓",
  ).join("");
  const label = terminalText(meter.label);
  const amount = (value: number) => value.toLocaleString("en-US");
  return `${label}${" ".repeat(Math.max(0, 11 - stringWidth(label)))} ${bar} ${((meter.demand / meter.limit) * 100).toFixed(0)}% | ~${amount(Math.round(meter.demand))} / ${amount(meter.limit)} ${terminalText(meter.unit)}`;
}
