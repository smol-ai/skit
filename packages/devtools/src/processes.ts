import { Context, Duration, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { VmError } from "./configuration.ts";

export interface ProcessOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: Uint8Array;
  readonly output?: "inherit" | "capture" | "quiet";
  readonly interactive?: boolean;
  readonly allowNonzero?: boolean;
  readonly secret?: boolean;
  readonly timeout?: Duration.Input | false;
}
export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export class Processes extends Context.Service<
  Processes,
  {
    readonly run: (
      executable: string,
      args: readonly string[],
      options?: ProcessOptions,
    ) => Effect.Effect<ProcessResult, VmError>;
  }
>()("devtools/Processes") {}
export const processesLayer = Layer.effect(
  Processes,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const run = Effect.fn("Processes.run")(function* (
      executable: string,
      args: readonly string[],
      options: ProcessOptions = {},
    ) {
      const capture = options.output === "capture" || options.secret === true;
      const command = ChildProcess.make(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        extendEnv: true,
        detached: !options.interactive,
        stdin:
          options.input === undefined
            ? options.interactive
              ? "inherit"
              : "ignore"
            : Stream.fromIterable([options.input]),
        stdout: capture ? "pipe" : options.output === "quiet" ? "ignore" : "inherit",
        stderr: capture ? "pipe" : options.output === "quiet" ? "ignore" : "inherit",
        forceKillAfter: "3 seconds",
      });
      const execute = Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(command);
          const [stdout, stderr, code] = yield* Effect.all(
            [
              capture
                ? child.stdout.pipe(Stream.decodeText(), Stream.mkString)
                : Effect.succeed(""),
              capture
                ? child.stderr.pipe(Stream.decodeText(), Stream.mkString)
                : Effect.succeed(""),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          if (code !== 0 && !options.allowNonzero)
            return yield* new VmError({
              message: options.secret
                ? "Credential operation failed; output was suppressed."
                : `${executable} ${args[0] ?? ""} exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(-4096)}` : ""}`,
            });
          return { code: Number(code), stdout, stderr };
        }),
      );
      return yield* (
        options.interactive || options.timeout === false
          ? execute
          : execute.pipe(Effect.timeout(options.timeout ?? "30 seconds"))
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "VmError"
            ? error
            : new VmError({
                message: options.secret
                  ? "Credential operation failed; output was suppressed."
                  : `${executable} ${args[0] ?? ""} failed (${error._tag}).`,
              }),
        ),
      );
    });
    return Processes.of({ run });
  }),
);
