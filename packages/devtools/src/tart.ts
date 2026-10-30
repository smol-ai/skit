import { Context, Duration, Effect, Exit, FileSystem, Layer, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Configuration, quote, VmError } from "./configuration.ts";
import type { PlatformError } from "effect/PlatformError";
import { Processes, type ProcessOptions, type ProcessResult } from "./processes.ts";

const Machine = Schema.Struct({
  Name: Schema.String,
  State: Schema.Literals(["running", "stopped", "suspended"]),
});
const decodeMachines = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Machine)));
class NotReady extends Schema.TaggedError<NotReady>()("NotReady", {}) {}
const poll = <E, R>(
  check: Effect.Effect<void, E | NotReady, R>,
  duration: Duration.Input,
  message: string,
) =>
  check.pipe(
    Effect.retry({
      schedule: Schedule.spaced("1 second"),
      while: (error): error is NotReady => Schema.is(NotReady)(error),
    }),
    Effect.timeoutOrElse({ duration, orElse: () => Effect.fail(new VmError({ message })) }),
    Effect.mapError((error) => (Schema.is(NotReady)(error) ? new VmError({ message }) : error)),
  );

// The adapter closes over platform/configuration services; workflow callers own only VM scopes.
export class Tart extends Context.Service<
  Tart,
  {
    readonly run: (
      args: readonly string[],
      options?: ProcessOptions,
    ) => Effect.Effect<ProcessResult, VmError>;
    readonly state: (
      name: string,
    ) => Effect.Effect<"running" | "stopped" | "suspended" | undefined, VmError>;
    readonly guest: (
      name: string,
      script: string,
      options?: ProcessOptions,
    ) => Effect.Effect<ProcessResult, VmError>;
    readonly start: (name: string) => Effect.Effect<void, VmError | PlatformError>;
    readonly stop: (name: string) => Effect.Effect<void, VmError>;
    readonly job: (
      name: string,
      script: string,
      options?: ProcessOptions,
      seconds?: number,
    ) => Effect.Effect<ProcessResult, VmError>;
  }
>()("devtools/Tart") {}

export const tartLayer = Layer.effect(
  Tart,
  Effect.gen(function* () {
    const config = yield* Configuration;
    const processes = yield* Processes;
    const fs = yield* FileSystem.FileSystem;
    const run = (args: readonly string[], options: ProcessOptions = {}) =>
      processes.run(config.tart, args, {
        ...options,
        env: { ...options.env, TART_HOME: join(config.root, "vms"), TART_NO_AUTO_PRUNE: "1" },
      });
    const state = Effect.fn("Tart.state")(function* (name: string) {
      const result = yield* run(["list", "--source", "local", "--format", "json"], {
        output: "capture",
        timeout: "10 seconds",
      });
      const machines = yield* decodeMachines(result.stdout).pipe(
        Effect.mapError(() => new VmError({ message: "Tart returned invalid machine metadata." })),
      );
      return machines.find((machine) => machine.Name === name)?.State;
    });
    const guest = (name: string, script: string, options?: ProcessOptions) =>
      run(
        [
          "exec",
          ...(options?.input === undefined ? [] : ["-i"]),
          name,
          "/bin/bash",
          "-lc",
          `set -euo pipefail\nexport PATH="$HOME/.local/bin:$PATH"\n${script}`,
        ],
        options,
      );
    const start = Effect.fn("Tart.start")(function* (name: string) {
      const current = yield* state(name);
      if (!current)
        return yield* new VmError({ message: `VM ${name} does not exist. Run pnpm vm new.` });
      const log = join(config.root, "logs", `${name}.log`);
      yield* fs.makeDirectory(join(config.root, "logs"), { recursive: true, mode: 0o700 });
      let pid: number | undefined;
      if (current !== "running") {
        if (current !== "stopped")
          return yield* new VmError({ message: `${name} is ${current}; stop it before starting.` });
        const result = yield* processes.run(
          process.execPath,
          [fileURLToPath(new URL("./launch-vm.mjs", import.meta.url)), config.tart, log, name],
          {
            output: "capture",
            env: { TART_HOME: join(config.root, "vms"), TART_NO_AUTO_PRUNE: "1" },
          },
        );
        pid = Number(result.stdout.trim());
        if (!Number.isInteger(pid) || pid <= 0)
          return yield* new VmError({ message: "VM launcher did not return a process id." });
      }
      const probe = Effect.gen(function* () {
        if (pid !== undefined) {
          const alive = yield* Effect.sync(() => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          });
          if (!alive)
            return yield* new VmError({ message: `Tart exited during boot. See ${log}.` });
        }
        yield* guest(name, "true", { output: "quiet", timeout: "3 seconds" }).pipe(
          Effect.mapError(() => new NotReady()),
        );
      });
      yield* poll(probe, "90 seconds", `Guest agent did not become ready. See ${log}.`);
    });
    const stop = Effect.fn("Tart.stop")(function* (name: string) {
      const current = yield* state(name);
      if (!current) return yield* new VmError({ message: `VM ${name} does not exist.` });
      if (current === "stopped") return;
      // Shutdown often closes the exec channel; still poll for the resulting stopped state.
      yield* guest(name, "sudo shutdown -h now", { output: "quiet", timeout: "5 seconds" }).pipe(
        Effect.ignore,
      );
      const stopped = state(name).pipe(
        Effect.flatMap((value) =>
          value === "stopped" ? Effect.void : Effect.fail(new NotReady()),
        ),
      );
      yield* poll(stopped, "20 seconds", "Graceful shutdown did not finish.").pipe(
        Effect.catchTag("VmError", () => run(["stop", name], { timeout: "40 seconds" })),
      );
      if ((yield* state(name)) !== "stopped")
        return yield* new VmError({ message: `${name} did not stop.` });
    });
    const job = Effect.fn("Tart.job")(function* (
      name: string,
      script: string,
      options: ProcessOptions = {},
      seconds = 600,
    ) {
      const boot = (yield* guest(name, "cat /proc/sys/kernel/random/boot_id", {
        output: "capture",
      })).stdout.trim();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(boot))
        return yield* new VmError({ message: "Guest returned an invalid boot identity." });
      const id = randomUUID();
      const jobs = `$HOME/.cache/skit-vm/jobs/${boot}`;
      const directory = `${jobs}/${id}`;
      // A PID authorizes cancellation only in the boot in which it was recorded.
      const bootFence = `test "$(cat /proc/sys/kernel/random/boot_id)" = ${quote(boot)}`;
      // A cancellation ticket also covers interruption before the guest publishes its process id.
      const acquire = guest(
        name,
        `${bootFence} || { echo 'Guest rebooted before job acquisition.' >&2; exit 75; }
        umask 077
        for previous in "${jobs}/"*; do
          test -d "$previous" || continue
          # A child never runs user code once its directory is gone, so finished or
          # pre-launch-cancelled jobs can be removed.
          if test -s "$previous/pid"; then
            previous_pid=$(cat "$previous/pid")
            if kill -0 -- "-$previous_pid" 2>/dev/null; then
              echo 'A prior guest job is still running. Stop the VM before retrying.' >&2; exit 75
            fi
          elif test ! -e "$previous/cancelled"; then
            echo 'A prior guest job has uncertain ownership. Stop the VM before retrying.' >&2; exit 75
          fi
          rm -rf "$previous"
        done
        mkdir -p "${directory}"`,
        { output: "capture" },
      );
      const cancel = guest(
        name,
        `${bootFence} || exit 0
      test -d "${directory}" || exit 0
      touch "${directory}/cancelled"
      if test -s "${directory}/pid"; then
        group=$(cat "${directory}/group" 2>/dev/null || cat "${directory}/pid")
        case "$group" in ''|0|*[!0-9]*) exit 1;; esac
        kill -TERM -- "-$group" 2>/dev/null || true
        timeout 5s /bin/bash -c 'while kill -0 -- "-$1" 2>/dev/null; do sleep 0.1; done' -- "$group" || true
        kill -KILL -- "-$group" 2>/dev/null || true
        timeout 2s /bin/bash -c 'while kill -0 -- "-$1" 2>/dev/null; do sleep 0.1; done' -- "$group" || exit 1
        rm -rf "${directory}"
      fi`,
        { output: "quiet", secret: options.secret, timeout: "10 seconds" },
      );
      // The child publishes its actual group and waits for approval before user code.
      // This checks the setsid assumption even if a login profile changes job control.
      const childScript = `test -d "${directory}" && test ! -e "${directory}/cancelled" || exit 130
        set -euo pipefail
        set +m
        ps -o pgid= -p $$ | tr -d ' ' > "${directory}/group.partial"
        mv "${directory}/group.partial" "${directory}/group"
        while test ! -e "${directory}/approved"; do
          test -d "${directory}" && test ! -e "${directory}/cancelled" || exit 130
          sleep 0.01
        done
        test ! -e "${directory}/cancelled" || exit 130
        export PATH="$HOME/.local/bin:$PATH"
        ${script}`;
      const wrapped = `${bootFence} || { echo 'Guest rebooted before job launch.' >&2; exit 75; }
      directory="${directory}"
      set +m
      if test ! -d "$directory" || test -e "$directory/cancelled"; then
        rm -rf "$directory"; exit 130
      fi
      setsid timeout --signal=TERM --kill-after=5s ${seconds}s /bin/bash -lc ${quote(childScript)} <&0 &
      pid=$!
      printf '%s\\n' "$pid" > "$directory/pid.partial"
      mv "$directory/pid.partial" "$directory/pid"
      for attempt in {1..3000}; do
        test -s "$directory/group" && break
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.01
      done
      group=$(cat "$directory/group" 2>/dev/null || true)
      if test "$group" != "$pid"; then
        case "$group" in ''|0|*[!0-9]*) ;; *) kill -KILL -- "-$group" 2>/dev/null || true;; esac
        kill -KILL "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        rm -rf "$directory"
        echo 'Guest process-group ownership check failed before running user code.' >&2
        exit 70
      fi
      if test -e "$directory/cancelled"; then
        kill -KILL -- "-$group" 2>/dev/null || true
      else
        touch "$directory/approved"
      fi
      set +e
      wait "$pid"
      code=$?
      kill -KILL -- "-$group" 2>/dev/null || true
      rm -rf "$directory"
      exit "$code"`;
      return yield* Effect.acquireUseRelease(
        acquire,
        () => guest(name, wrapped, { ...options, timeout: `${seconds + 15} seconds` }),
        (_, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : cancel.pipe(
                Effect.catchTag("VmError", () =>
                  Effect.logError(
                    `Could not confirm guest-job cancellation in ${name}; stop the VM before retrying.`,
                  ),
                ),
              ),
      );
    });
    return { run, state, guest, start, stop, job };
  }),
);
