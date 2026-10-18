// Every byte the CLI writes goes through this service. The console implementation owns stdout,
// stderr and the exit code; a test or the TUI provides its own and nothing below changes.

import { stripVTControlCharacters } from "node:util";
import { Clock, Context, Effect, Exit, Fiber, Layer } from "effect";
import type { CommandFailure, CommandResult } from "../commands/types.js";
import {
  renderFailureFrame,
  renderHelpFrame,
  renderNoteFrame,
  renderResultFrame,
} from "./output-frame.js";
import { terminalColors, terminalColorEnabled } from "./terminal-style.js";

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
  /** One numbered step of a guided flow, announced before its question. Suppressed like a note. */
  readonly step: (
    step: { readonly index: number; readonly total: number; readonly title: string },
    body: string,
  ) => Effect.Effect<void>;
  /** Replace the message of the currently visible status without starting another spinner. */
  readonly updateStatus: (message: string) => Effect.Effect<void>;
  /** Explicit, line-oriented progress for automation, including JSON mode. */
  readonly progress?: (message: string) => Effect.Effect<void>;
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

import { CLEAR_STATUS_LINE, STATUS_FRAME_MS, renderStatusLine } from "./terminal-status.js";

const formatElapsed = (milliseconds: number): string =>
  milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;

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

  const note = (body: string, title: string) => {
    const frame = renderNoteFrame(body, title, format);
    return Effect.suspend(() => {
      if (!frame.stderr) return Effect.void;
      const resumeStatus = statusVisible;
      return clearStatus.pipe(
        Effect.andThen(write(process.stderr, frame.stderr)),
        Effect.tap(() =>
          Effect.sync(() => {
            statusVisible = resumeStatus;
          }),
        ),
      );
    });
  };

  return {
    result: (result, options) =>
      Effect.gen(function* () {
        const frame = renderResultFrame(result, {
          color: terminalColorEnabled(process.stdout),
          detail: options?.detail ?? "summary",
          format,
        });
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
    note: (body, title, options) =>
      note(options?.renderBody(terminalColorEnabled()) ?? body, terminalColors().bold(title)),
    step: ({ index, total, title }, body) => {
      const color = terminalColors();
      return note(body, `${color.dim(`Step ${index} of ${total} ·`)} ${color.bold(title)}`);
    },
    updateStatus: (message) =>
      Effect.sync(() => {
        if (statusVisible) statusMessage = message;
      }),
    progress: (message) =>
      write(process.stderr, `${stripVTControlCharacters(message).replace(/[\r\n\t]/g, " ")}\n`),
    withStatus: (status, operation) => {
      if (json) return operation;
      const timed = typeof status !== "string" && status.persist === "timed";
      const interactive = Boolean(process.stderr.isTTY);
      if (!interactive && !timed) return operation;
      return Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          const pending = typeof status === "string" ? status : status.pending;
          let frame = 0;
          statusMessage = pending;
          statusVisible = interactive;
          const spinner = interactive
            ? yield* Effect.forever(
                Effect.gen(function* () {
                  const elapsed = (yield* Clock.currentTimeMillis) - started;
                  const message = timed
                    ? `${statusMessage} · ${formatElapsed(elapsed)}`
                    : statusMessage;
                  yield* write(
                    process.stderr,
                    `${CLEAR_STATUS_LINE}${renderStatusLine(message, frame++)}`,
                  );
                }).pipe(Effect.andThen(Effect.sleep(STATUS_FRAME_MS))),
              ).pipe(Effect.forkScoped)
            : undefined;
          return yield* operation.pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                if (spinner) yield* Fiber.interrupt(spinner);
                yield* clearStatus;
                const elapsed = (yield* Clock.currentTimeMillis) - started;
                const duration = formatElapsed(elapsed);
                const suffix = timed ? ` · ${duration}` : "";
                if (typeof status !== "string" && Exit.isSuccess(exit)) {
                  const message =
                    typeof status.complete === "string"
                      ? status.complete
                      : status.complete(exit.value);
                  yield* write(process.stderr, `✓ ${message}${suffix}\n`);
                } else if (timed) {
                  yield* write(process.stderr, `✖ ${pending} · Incomplete${suffix}\n`);
                }
              }),
            ),
          );
        }),
      );
    },
  };
}

export const consoleRendererLayer = (json: boolean): Layer.Layer<Renderer> =>
  Layer.succeed(Renderer)(consoleRenderer(json));
