import type { Effect } from "effect";
import type { TerminalEnvironment } from "../terminal/contracts.js";

/** One rendered screen; seeking and playback never rerun a command. */
export interface ReplayFrame {
  readonly label: string;
  readonly output: string;
  readonly status?: string;
  readonly prompt?: string;
}

/** A captured journey exposes presentation, keeping command results and prompt events private. */
export interface JourneyRecording {
  readonly name: string;
  readonly initialState: string;
  readonly finalState: string;
  readonly frames: (environment: TerminalEnvironment) => readonly ReplayFrame[];
  readonly transcript: (environment: TerminalEnvironment, cwd: string) => string;
}

export interface Journey {
  readonly name: string;
  readonly record: Effect.Effect<JourneyRecording>;
}

export interface Output {
  readonly key: string;
}
