import { createColors } from "picocolors";

/** Match the stream being drawn, while respecting explicit terminal color preferences. */
export const terminalColorEnabled = (stream: NodeJS.WriteStream = process.stderr): boolean =>
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  (process.env.FORCE_COLOR === undefined ? Boolean(stream.isTTY) : process.env.FORCE_COLOR !== "0");

export const terminalColors = (stream: NodeJS.WriteStream = process.stderr) =>
  createColors(terminalColorEnabled(stream));
