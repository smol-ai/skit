import { renderStatusLine } from "../terminal/status.js";
import type { ReplayFrame } from "./contracts.js";

export function renderReplayFrame(frame: ReplayFrame, spinnerFrame: number): string {
  return (
    frame.output +
    (frame.prompt ? `${frame.prompt}\n` : "") +
    (frame.status ? renderStatusLine(frame.status, spinnerFrame) : "")
  );
}
