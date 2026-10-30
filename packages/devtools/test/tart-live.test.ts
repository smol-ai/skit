import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Deferred, Effect, Fiber, Layer, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { configurationLayer, quote, VmError } from "../src/configuration.ts";
import { Processes, processesLayer, type ProcessOptions } from "../src/processes.ts";
import { Tart, tartLayer } from "../src/tart.ts";

// Explicit opt-in: uses an existing trial, makes no account/model calls, changes only /tmp.
const name = process.env.SKIT_VM_TEST_NAME;
it.live.skipIf(!name)(
  "cancels the owned guest process group while preserving the VM",
  () =>
    Effect.gen(function* () {
      if (!name) return;
      const tart = yield* Tart;
      const suffix = randomUUID();
      const pidFile = `/tmp/skit-vm-job-${suffix}.pid`;
      const finished = `/tmp/skit-vm-job-${suffix}.finished`;
      yield* tart.start(name);
      const job = yield* tart
        .job(
          name,
          `ps -o pgid= -p $$ | tr -d ' ' > ${quote(pidFile)}; sleep 60; touch ${quote(finished)}`,
          { output: "quiet" },
          70,
        )
        .pipe(Effect.forkScoped);
      const pid = yield* tart
        .guest(name, `test -s ${quote(pidFile)}; cat ${quote(pidFile)}`, { output: "capture" })
        .pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }));
      expect(pid.stdout.trim()).toMatch(/^\d+$/);
      yield* Fiber.interrupt(job);
      yield* tart.guest(
        name,
        `! kill -0 -- -${pid.stdout.trim()} 2>/dev/null; test ! -e ${quote(finished)}`,
      );
      expect(yield* tart.state(name)).toBe("running");
      yield* tart.guest(name, `rm -f ${quote(pidFile)} ${quote(finished)}`);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        tartLayer.pipe(Layer.provide(configurationLayer), Layer.provide(processesLayer)),
      ),
      Effect.provide(NodeServices.layer),
    ),
  { timeout: 30_000 },
);

it.live.skipIf(!name)(
  "a launch delivered after pre-launch cancellation never runs user code",
  () =>
    Effect.gen(function* () {
      if (!name) return;
      const base = yield* Processes;
      const launch = yield* Deferred.make<{
        executable: string;
        args: readonly string[];
        options?: ProcessOptions;
      }>();
      const proxy = Processes.of({
        run: (executable, args, options) => {
          if (args[0] === "exec" && args.at(-1)?.includes("setsid timeout")) {
            return Deferred.succeed(launch, { executable, args, options }).pipe(
              Effect.andThen(Effect.never),
            );
          }
          return base.run(executable, args, options);
        },
      });
      yield* Effect.gen(function* () {
        const tart = yield* Tart;
        yield* tart.start(name);
        const sentinel = `/tmp/skit-vm-late-${randomUUID()}`;
        const job = yield* tart
          .job(name, `touch ${quote(sentinel)}`, { output: "quiet" })
          .pipe(Effect.forkScoped);
        const invocation = yield* Deferred.await(launch);
        yield* Fiber.interrupt(job);
        // Deliberately deliver the captured launch only after its scope has cancelled it.
        const late = yield* base.run(invocation.executable, invocation.args, {
          ...invocation.options,
          allowNonzero: true,
        });
        // Tart may normalize a non-PTY interrupted exit; the boundary must reject it.
        expect(late.code).not.toBe(0);
        const ticket = invocation.args.at(-1)?.match(/jobs\/([0-9a-f-]{36}\/[0-9a-f-]{36})/)?.[1];
        expect(ticket).toBeDefined();
        if (!ticket) return yield* new VmError({ message: "Missing captured job ticket." });
        yield* tart.guest(
          name,
          `test ! -e ${quote(sentinel)}; test ! -e "$HOME/.cache/skit-vm/jobs/${ticket}"`,
        );
      }).pipe(Effect.provide(tartLayer.pipe(Layer.provide(Layer.succeed(Processes, proxy)))));
    }).pipe(
      Effect.scoped,
      Effect.provide(processesLayer),
      Effect.provide(configurationLayer),
      Effect.provide(NodeServices.layer),
    ),
  { timeout: 30_000 },
);

it.live.skipIf(!name)(
  "ordinary nonzero guest jobs do not recreate cancellation tickets",
  () =>
    Effect.gen(function* () {
      if (!name) return;
      const tart = yield* Tart;
      yield* tart.start(name);
      const count =
        'mkdir -p "$HOME/.cache/skit-vm/jobs"; find "$HOME/.cache/skit-vm/jobs" -mindepth 2 -maxdepth 2 -type d | wc -l';
      const before = yield* tart.guest(name, count, { output: "capture" });
      const failure = yield* tart.job(name, "exit 7", { output: "quiet" }).pipe(Effect.result);
      expect(failure._tag).toBe("Failure");
      const after = yield* tart.guest(name, count, { output: "capture" });
      expect(after.stdout.trim()).toBe(before.stdout.trim());
    }).pipe(
      Effect.scoped,
      Effect.provide(
        tartLayer.pipe(Layer.provide(configurationLayer), Layer.provide(processesLayer)),
      ),
      Effect.provide(NodeServices.layer),
    ),
  { timeout: 30_000 },
);

it.live.skipIf(!name)(
  "refuses a launcher that changes the process-group leader before user code",
  () =>
    Effect.gen(function* () {
      if (!name) return;
      const tart = yield* Tart;
      yield* tart.start(name);
      const sentinel = `/tmp/skit-vm-group-${randomUUID()}`;
      const install = tart.guest(
        name,
        `test ! -e "$HOME/.local/bin/setsid"
    printf '%s\\n' '#!/bin/sh' 'exec /usr/bin/setsid --fork "$@"' > "$HOME/.local/bin/setsid"
    chmod 700 "$HOME/.local/bin/setsid"`,
      );
      yield* Effect.acquireUseRelease(
        install,
        () =>
          Effect.gen(function* () {
            const result = yield* tart
              .job(name, `touch ${quote(sentinel)}`, { output: "capture" })
              .pipe(Effect.result);
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure")
              expect(result.failure.message).toContain("process-group ownership check failed");
            yield* tart.guest(name, `test ! -e ${quote(sentinel)}`);
          }),
        () => tart.guest(name, 'rm -f "$HOME/.local/bin/setsid"'),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        tartLayer.pipe(Layer.provide(configurationLayer), Layer.provide(processesLayer)),
      ),
      Effect.provide(NodeServices.layer),
    ),
  { timeout: 30_000 },
);

it.live.skipIf(!name)(
  "ignores interrupted tickets from a prior boot after a real stop/start",
  () =>
    Effect.gen(function* () {
      if (!name) return;
      const tart = yield* Tart;
      yield* tart.start(name);
      const before = (yield* tart.guest(name, "cat /proc/sys/kernel/random/boot_id", {
        output: "capture",
      })).stdout.trim();
      expect(before).toMatch(/^[0-9a-f-]{36}$/);
      const ticket = `$HOME/.cache/skit-vm/jobs/${before}/${randomUUID()}`;
      yield* Effect.acquireUseRelease(
        tart.guest(name, `mkdir -p "${ticket}"`),
        () =>
          Effect.gen(function* () {
            const blocked = yield* tart.job(name, "true", { output: "quiet" }).pipe(Effect.result);
            expect(blocked._tag).toBe("Failure");
            if (blocked._tag === "Failure")
              expect(blocked.failure.message).toContain("uncertain ownership");
            yield* tart.stop(name);
            yield* tart.start(name);
            const after = (yield* tart.guest(name, "cat /proc/sys/kernel/random/boot_id", {
              output: "capture",
            })).stdout.trim();
            expect(after).not.toBe(before);
            // Even a PID-like record in the old boot cannot authorize new-boot work or cancellation.
            yield* tart.guest(name, `printf '%s\\n' 42 > "${ticket}/pid"`);
            yield* tart.job(name, "true", { output: "quiet" });
            yield* tart.guest(name, `test -d "${ticket}"`);
          }),
        () => tart.start(name).pipe(Effect.andThen(tart.guest(name, `rm -rf "${ticket}"`))),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        tartLayer.pipe(Layer.provide(configurationLayer), Layer.provide(processesLayer)),
      ),
      Effect.provide(NodeServices.layer),
    ),
  { timeout: 45_000 },
);
