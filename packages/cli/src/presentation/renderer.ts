// Every byte the CLI writes goes through this service. The console implementation owns stdout,
// stderr and the exit code; a test or the TUI provides its own and nothing below changes.

import { Context, Effect, Exit, Fiber, Layer } from "effect";
import type { CommandFailure, CommandResult } from "../commands/types.js";
import {
  renderFailureFrame,
  renderHelpFrame,
  renderNoteFrame,
  renderResultFrame,
} from "./output-frame.js";

export interface RendererShape {
  /** A command's successful payload: JSON or rendered text, plus any declared exit code. */
  readonly result: (
    result: CommandResult,
    options?: { readonly detail?: "summary" | "full" },
  ) => Effect.Effect<void>;
  readonly failure: (failure: CommandFailure) => Effect.Effect<void>;
  readonly help: (text: string) => Effect.Effect<void>;
  /** An aside during an interactive flow. Suppressed when the caller asked for JSON. */
  readonly note: (body: string, title: string) => Effect.Effect<void>;
  /** Replace the message of the currently visible status without starting another spinner. */
  readonly updateStatus: (message: string) => Effect.Effect<void>;
  /** Progress around a running effect, released on every exit including interruption. */
  readonly withStatus: <A, E, R>(
    status:
      | string
      | {
          readonly pending: string;
          readonly complete: string | ((value: A) => string);
        },
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class Renderer extends Context.Service<Renderer, RendererShape>()("skit/Renderer") {}

const CLEAR_STATUS_LINE = "\r\u001b[2K";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const write = (stream: NodeJS.WriteStream, body: string) =>
  Effect.callback<void>((resume) => {
    stream.write(body, () => resume(Effect.void));
  });

export function consoleRenderer(json: boolean): RendererShape {
  const format = json ? "json" : "human";
  let statusVisible = false;
  let statusMessage = "";
  const clearStatus = Effect.suspend(() => {
    if (!statusVisible) return Effect.void;
    statusVisible = false;
    return write(process.stderr, CLEAR_STATUS_LINE);
  });

  return {
    result: (result, options) =>
      Effect.gen(function* () {
        const frame = renderResultFrame(result, {
          color: process.stdout.isTTY,
          detail: options?.detail ?? "summary",
          format,
        });
        if (frame === undefined)
          return yield* Effect.die(`No text presenter registered for ${result.schema}`);
        yield* write(process.stdout, frame.stdout);
        if (frame.exitCode !== undefined) process.exitCode = frame.exitCode;
      }),
    failure: (failure) =>
      Effect.gen(function* () {
        const frame = renderFailureFrame(failure, format);
        yield* write(process.stderr, frame.stderr);
        process.exitCode = frame.exitCode;
      }),
    help: (text) => write(process.stdout, renderHelpFrame(text, format).stdout),
    note: (body, title) => {
      const frame = renderNoteFrame(body, title, format);
      return frame.stderr
        ? clearStatus.pipe(Effect.andThen(write(process.stderr, frame.stderr)))
        : Effect.void;
    },
    updateStatus: (message) =>
      Effect.sync(() => {
        if (statusVisible) statusMessage = message;
      }),
    withStatus: (status, operation) =>
      json || !process.stderr.isTTY
        ? operation
        : Effect.scoped(
            Effect.gen(function* () {
              const pending = typeof status === "string" ? status : status.pending;
              let frame = 0;
              statusMessage = pending;
              statusVisible = true;
              const spinner = yield* Effect.forever(
                Effect.suspend(() =>
                  write(
                    process.stderr,
                    `${CLEAR_STATUS_LINE}${SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]} ${statusMessage}`,
                  ),
                ).pipe(Effect.andThen(Effect.sleep(80))),
              ).pipe(Effect.forkScoped);
              return yield* operation.pipe(
                Effect.onExit((exit) =>
                  Fiber.interrupt(spinner).pipe(
                    Effect.andThen(
                      typeof status !== "string" && Exit.isSuccess(exit)
                        ? write(
                            process.stderr,
                            `${CLEAR_STATUS_LINE}✓ ${typeof status.complete === "string" ? status.complete : status.complete(exit.value)}\n`,
                          ).pipe(
                            Effect.tap(() =>
                              Effect.sync(() => {
                                statusVisible = false;
                              }),
                            ),
                          )
                        : clearStatus,
                    ),
                  ),
                ),
              );
            }),
          ),
  };
}

export const consoleRendererLayer = (json: boolean): Layer.Layer<Renderer> =>
  Layer.succeed(Renderer)(consoleRenderer(json));
