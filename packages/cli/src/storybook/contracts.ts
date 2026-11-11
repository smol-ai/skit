import type { Effect } from "effect";
import type { TerminalEnvironment } from "../terminal/contracts.js";
import type { PromptKind } from "./interaction-recorder.js";

/** Structured inputs shared by scenario setup, flow presentation and fork comparison. */
export type StartingWorld = Readonly<Record<string, string | number | boolean | readonly string[]>>;

/** Journey summaries and scenario inputs are distinct recording shapes. */
export type StoryState =
  | { readonly _tag: "Journey"; readonly initialState: string; readonly finalState: string }
  | {
      readonly _tag: "Scenario";
      readonly world: StartingWorld;
      readonly worldLabels: Readonly<Record<string, string>>;
      readonly terminalDevice: string;
    };

/** One rendered screen; seeking and playback never rerun a command. */
export interface ReplayFrame {
  readonly label: string;
  readonly rule?: string;
  readonly output: string;
  readonly status?: string;
  readonly prompt?: string;
  /** On a result screen: the output contract it reports and, when the contract has several, its state. */
  readonly outcome?: {
    readonly contract: string;
    readonly state?: string;
    readonly variants?: readonly { readonly field: string; readonly value: string }[];
  };
  /** On an answered prompt: the visible choices it offered and the ones the script took. */
  readonly answer?: {
    readonly kind: PromptKind;
    readonly offered: readonly string[];
    readonly chosen: readonly string[];
  };
}

/** A captured journey exposes presentation and outcome names, keeping command results private. */
export type JourneyRecording = StoryState & {
  readonly name: string;
  /** The command lines the journey typed, in order. */
  readonly commands: readonly string[];
  readonly frames: (environment: TerminalEnvironment) => readonly ReplayFrame[];
  readonly transcript: (environment: TerminalEnvironment, cwd: string) => string;
};

export interface Journey {
  readonly name: string;
  readonly description: string;
  readonly evidence?: string;
  readonly record: Effect.Effect<JourneyRecording>;
}

export interface Output {
  readonly key: string;
  readonly errorTags?: readonly string[];
  readonly scenario?: {
    readonly initial: string;
    readonly trigger: string;
    readonly result: string;
  };
}
