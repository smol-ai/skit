import { Context, Effect } from "effect";
import type { CommandFailure, CommandResult } from "../commands/types.js";
import type { Block } from "./blocks.js";

export interface RendererShape {
  /** A command's successful payload: JSON or rendered text, plus any declared exit code. */
  readonly result: (
    result: CommandResult,
    options?: { readonly detail?: "summary" | "full"; readonly jsonLines?: boolean },
  ) => Effect.Effect<void>;
  readonly failure: (failure: CommandFailure) => Effect.Effect<void>;
  readonly help: (text: string) => Effect.Effect<void>;
  /**
   * An aside during an interactive flow. Suppressed when the caller asked for JSON.
   */
  readonly note: (body: readonly Block[], title: string) => Effect.Effect<void>;
  /**
   * Something the user must do outside this command while it waits, such as approving a login in
   * a browser. Written to stderr even when the caller asked for JSON: without it the command waits
   * on nobody.
   */
  readonly instruction: (body: readonly Block[], title: string) => Effect.Effect<void>;
  /** One numbered step of a guided flow, announced before its question. Suppressed like a note. */
  readonly step: (
    step: { readonly index: number; readonly total: number; readonly title: string },
    body: readonly Block[],
  ) => Effect.Effect<void>;
  /** Replace the message of the currently visible status without starting another spinner. */
  readonly updateStatus: (message: string) => Effect.Effect<void>;
  /** Progress around a running effect, released on every exit including interruption. */
  readonly withStatus: <A, E, R>(
    status:
      | string
      | {
          readonly pending: string;
          readonly persist?: "timed";
          readonly complete: string | ((value: A) => string);
        },
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class Renderer extends Context.Service<Renderer, RendererShape>()("skit/Renderer") {}
