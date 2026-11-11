import { Block, renderBlocks } from "./blocks.js";
import type { TerminalFrame } from "./contracts.js";
import { resultExitCode } from "../commands/exit-code.js";
import { Clock, Effect, Exit, Fiber, Layer } from "effect";
import { Renderer, type RendererShape } from "./renderer.js";
import {
  renderFailureFrame,
  renderHelpFrame,
  renderNoteFrame,
  renderStepFrame,
  renderResultFrame,
} from "../commands/output-frame.js";
import { terminalColorEnabled } from "./style.js";
import { automationMarker } from "./interactivity.js";

import { CLEAR_STATUS_LINE, STATUS_FRAME_MS, renderStatusLine } from "./status.js";
import { terminalText } from "./text.js";
import { compactHome } from "./home-path.js";
import { homedir } from "node:os";

const formatElapsed = (milliseconds: number): string =>
  milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;

const write = (stream: NodeJS.WriteStream, body: string) =>
  Effect.callback<void>((resume) => {
    stream.write(body, (error) => resume(error ? Effect.die(error) : Effect.void));
  });

export function consoleRenderer(json: boolean): RendererShape {
  const format: "json" | "human" = json ? "json" : "human";
  const home = homedir();
  // Status and progress text, as a person reads it.
  const shown = (text: string) => compactHome(terminalText(text), home);
  let statusVisible = false;
  let statusMessage = "";
  const clearStatus = Effect.suspend(() => {
    if (!statusVisible) return Effect.void;
    statusVisible = false;
    return write(process.stderr, CLEAR_STATUS_LINE);
  });

  const noteEnvironment = () => ({
    format,
    home,
    color: terminalColorEnabled(),
    ...(process.stderr.columns ? { width: process.stderr.columns } : {}),
  });
  const note = (frame: TerminalFrame) => {
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
        const frame = renderResultFrame(
          result,
          {
            color: terminalColorEnabled(process.stdout),
            detail: options?.detail ?? "summary",
            format,
            home,
            ...(process.stdout.columns ? { width: process.stdout.columns } : {}),
          },
          { jsonLines: options?.jsonLines },
        );
        yield* write(process.stdout, frame.stdout);
        process.exitCode = resultExitCode(result, Number(process.exitCode ?? 0));
      }),
    failure: (failure) =>
      Effect.gen(function* () {
        const frame = renderFailureFrame(failure, {
          format,
          home,
          color: terminalColorEnabled(process.stderr),
          ...(process.stderr.columns ? { width: process.stderr.columns } : {}),
        });
        yield* write(process.stderr, frame.stderr);
        process.exitCode = frame.exitCode;
      }),
    help: (text) => write(process.stdout, renderHelpFrame(text, format).stdout),
    note: (body, title) => note(renderNoteFrame(body, title, noteEnvironment())),
    instruction: (body, title) =>
      note(renderNoteFrame(body, title, { ...noteEnvironment(), format: "human" })),
    step: (step, body) => note(renderStepFrame(step, body, noteEnvironment())),
    updateStatus: (message) =>
      Effect.sync(() => {
        if (statusVisible) statusMessage = shown(message);
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
          const pending = shown(typeof status === "string" ? status : status.pending);
          let frame = 0;
          statusMessage = pending;
          statusVisible = interactive;
          const spinner = interactive
            ? yield* Effect.forever(
                Effect.gen(function* () {
                  const elapsed = (yield* Clock.currentTimeMillis) - started;
                  const message = timed
                    ? `${statusMessage} | ${formatElapsed(elapsed)}`
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
                const suffix = timed ? ` | ${duration}` : "";
                if (typeof status !== "string" && Exit.isSuccess(exit)) {
                  const message = shown(
                    typeof status.complete === "string"
                      ? status.complete
                      : status.complete(exit.value),
                  );
                  yield* write(
                    process.stderr,
                    `${renderBlocks([Block.Status({ tone: "ok", text: [message + suffix] })], noteEnvironment())}\n`,
                  );
                } else if (timed) {
                  yield* write(
                    process.stderr,
                    `${renderBlocks([Block.Status({ tone: "error", text: [`${pending} | Incomplete${suffix}`] })], noteEnvironment())}\n`,
                  );
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
