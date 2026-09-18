import { Context, Data, Effect, Layer, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STDOUT_BYTES = 4_000_000;
const DEFAULT_STDERR_BYTES = 8_000;

export interface SourceProcessOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxErrorBytes?: number;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface SourceProcessResult {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
}

export class SourceProcessOutputTooLarge extends Data.TaggedError("SourceProcess.OutputTooLarge")<{
  invocation: string;
  stream: "stdout" | "stderr";
  limit: number;
  message: string;
}> {}

export class SourceProcessTimedOut extends Data.TaggedError("SourceProcess.TimedOut")<{
  invocation: string;
  timeoutMs: number;
  message: string;
}> {}

export type SourceProcessFailure =
  | PlatformError
  | SourceProcessOutputTooLarge
  | SourceProcessTimedOut;

export interface SourceProcessShape {
  readonly run: (
    command: string,
    args: readonly string[],
    options?: SourceProcessOptions,
  ) => Effect.Effect<Omit<SourceProcessResult, "stdout">, SourceProcessFailure>;
  readonly output: (
    command: string,
    args: readonly string[],
    options?: SourceProcessOptions,
  ) => Effect.Effect<SourceProcessResult, SourceProcessFailure>;
}

export class SourceProcess extends Context.Service<SourceProcess, SourceProcessShape>()(
  "skit/SourceProcess",
) {}

const invocationOf = (command: string, args: readonly string[]) => [command, ...args].join(" ");

const concatenate = (chunks: readonly Uint8Array[], size: number) => {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

export const sourceProcessLayer: Layer.Layer<
  SourceProcess,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  SourceProcess,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const execute = Effect.fn("SourceProcess.execute")(function* (
      command: string,
      args: readonly string[],
      options: SourceProcessOptions = {},
      keepOutput: boolean,
    ) {
      const invocation = invocationOf(command, args);
      const outputLimit = options.maxOutputBytes ?? DEFAULT_STDOUT_BYTES;
      const errorLimit = options.maxErrorBytes ?? DEFAULT_STDERR_BYTES;
      let child: ChildProcess.Command = ChildProcess.make(command, [...args], { extendEnv: true });
      if (options.cwd !== undefined) child = ChildProcess.setCwd(child, options.cwd);
      const environment = {
        ...(command === "git" || command.endsWith("/git") ? { GIT_TERMINAL_PROMPT: "0" } : {}),
        ...options.environment,
      };
      if (Object.keys(environment).length > 0) child = ChildProcess.setEnv(child, environment);

      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(child);
          const collect = (
            stream: Stream.Stream<Uint8Array, PlatformError>,
            name: "stdout" | "stderr",
            limit: number,
            keep: boolean,
          ) =>
            Effect.suspend(() => {
              const chunks: Uint8Array[] = [];
              let size = 0;
              return Stream.runForEach(stream, (chunk) =>
                Effect.suspend(() => {
                  size += chunk.length;
                  if (size > limit)
                    return Effect.fail(
                      new SourceProcessOutputTooLarge({
                        invocation,
                        stream: name,
                        limit,
                        message: `${invocation} produced more than ${limit} bytes on ${name}`,
                      }),
                    );
                  if (keep) chunks.push(chunk.slice());
                  return Effect.void;
                }),
              ).pipe(Effect.map(() => (keep ? concatenate(chunks, size) : new Uint8Array())));
            });
          const [stdout, stderrBytes] = yield* Effect.all(
            [
              collect(handle.stdout, "stdout", outputLimit, keepOutput),
              collect(handle.stderr, "stderr", errorLimit, true),
            ],
            { concurrency: 2 },
          );
          return {
            stdout,
            stderr: new TextDecoder().decode(stderrBytes).trim(),
            exitCode: yield* handle.exitCode,
          };
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              new SourceProcessTimedOut({
                invocation,
                timeoutMs,
                message: `${invocation} timed out after ${timeoutMs}ms`,
              }),
            ),
        }),
      );
    });

    return SourceProcess.of({
      run: (command, args, options) =>
        execute(command, args, options, false).pipe(
          Effect.map(({ stderr, exitCode }) => ({ stderr, exitCode })),
        ),
      output: (command, args, options) => execute(command, args, options, true),
    });
  }),
);
