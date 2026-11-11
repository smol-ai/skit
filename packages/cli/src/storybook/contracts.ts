import type { Effect } from "effect";
import type { TerminalEnvironment } from "../terminal/contracts.js";

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

export interface InvocationParameter {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly type: string;
  readonly valueName?: string;
  readonly description: string;
  readonly required: boolean;
  readonly repeated: boolean;
  readonly min: number;
  readonly max?: number;
  readonly choices?: readonly string[];
  readonly negation?: string;
  readonly optionalValue?: string;
  /** These global tokens name a command option when used at the selected command. */
  readonly shadowedTokens?: readonly string[];
  readonly beforeCommandExample?: string;
  readonly globalKind?: "action" | "setting";
  readonly default: { readonly status: "none" | "value" | "unavailable"; readonly value?: string };
  readonly missing: readonly string[];
}

export interface CommandInvocation {
  readonly usage: string;
  readonly handlerRules: readonly string[];
  readonly summary: string;
  readonly examples: readonly string[];
  readonly arguments: readonly InvocationParameter[];
  readonly options: readonly (InvocationParameter & {
    readonly scope: "local" | "inherited" | "global";
  })[];
  readonly missing: readonly string[];
}

export type PromptKind =
  | "select"
  | "autocomplete"
  | "multiselect"
  | "confirm"
  | "text"
  | "password";

export interface ContractCoverage {
  readonly contract: string;
  /** The field that names the contract's states; absent when the contract has a single state. */
  readonly field?: "status" | "event" | "action";
  readonly states: ReadonlyArray<{ readonly state: string; readonly stories: readonly string[] }>;
  /** Stories for the contract, whatever state they show. */
  readonly stories: readonly string[];
  readonly variants?: readonly {
    readonly state: string;
    readonly field: string;
    readonly value: string;
    readonly stories: readonly string[];
  }[];
}

export interface CommandCoverage {
  /** The command as typed after `skit`, such as `author sync`. */
  readonly command: string;
  readonly interactive: boolean;
  readonly rules?: readonly string[];
  readonly scenarios?: readonly {
    readonly name: string;
    readonly description: string;
    readonly flow?: string;
  }[];
  readonly details?: readonly {
    readonly title: string;
    readonly body: string;
    readonly source: string;
  }[];
  readonly invocation: CommandInvocation;
  /** The result contracts the command declares. */
  readonly contracts: readonly string[];
  /** Output stories for these contracts that apply to this command. */
  readonly stories: readonly string[];
}
