import { Clock, Effect, Exit, Fiber, Layer } from "effect";
import { Renderer, type RendererShape } from "./renderer.js";
import {
  renderFailureFrame,
  renderHelpFrame,
  renderNoteFrame,
  renderResultFrame,
} from "../commands/output-frame.js";
import { terminalColors, terminalColorEnabled } from "./style.js";
import { automationMarker } from "./interactivity.js";

import { CLEAR_STATUS_LINE, STATUS_FRAME_MS, renderStatusLine } from "./status.js";
import { terminalText } from "./text.js";

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

  const note = (body: string, title: string, frameFormat: typeof format = format) => {
    const frame = renderNoteFrame(body, title, frameFormat);
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
    note: (body, title, options) => {
      const color = terminalColors();
      return note(
        options?.renderBody(terminalColorEnabled()) ?? terminalText(body),
        color.cyan(color.bold(terminalText(title))),
      );
    },
    instruction: (body, title) => {
      const color = terminalColors();
      return note(terminalText(body), color.cyan(color.bold(terminalText(title))), "human");
    },
    step: ({ index, total, title }, body) => {
      const color = terminalColors();
      return note(
        terminalText(body),
        `${color.dim(`Step ${index} of ${total} ·`)} ${color.bold(terminalText(title))}`,
      );
    },
    updateStatus: (message) =>
      Effect.sync(() => {
        if (statusVisible) statusMessage = terminalText(message);
      }),
    withStatus: (status, operation) => {
      if (json) return operation;
      const timed = typeof status !== "string" && status.persist === "timed";
      // An agent reads the whole transcript, so spinner frames are noise there even on a terminal.
      const interactive = Boolean(process.stderr.isTTY) && automationMarker() === undefined;
      if (!interactive && !timed) return operation;
      return Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          const pending = terminalText(typeof status === "string" ? status : status.pending);
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
                  const message = terminalText(
                    typeof status.complete === "string"
                      ? status.complete
                      : status.complete(exit.value),
                  );
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
