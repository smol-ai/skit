import { Context, Effect } from "effect";
import type { CommandFailure, CommandResult } from "../commands/types.js";

export interface RendererShape {
  /** A command's successful payload: JSON or rendered text, plus any declared exit code. */
  readonly result: (
    result: CommandResult,
    options?: { readonly detail?: "summary" | "full" },
  ) => Effect.Effect<void>;
  readonly failure: (failure: CommandFailure) => Effect.Effect<void>;
  readonly help: (text: string) => Effect.Effect<void>;
  /** An aside during an interactive flow. Suppressed when the caller asked for JSON. */
  readonly note: (
    body: string,
    title: string,
    options?: { readonly renderBody: (color: boolean) => string },
  ) => Effect.Effect<void>;
  /**
   * Something the user must do outside this command while it waits, such as approving a login in
   * a browser. Written to stderr even when the caller asked for JSON: without it the command waits
   * on nobody.
   */
  readonly instruction: (body: string, title: string) => Effect.Effect<void>;
  /** One numbered step of a guided flow, announced before its question. Suppressed like a note. */
  readonly step: (
    step: { readonly index: number; readonly total: number; readonly title: string },
    body: string,
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
