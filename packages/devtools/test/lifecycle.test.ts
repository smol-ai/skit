import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Ref,
  Schedule,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";
import { TestClock } from "effect/testing";
import { join } from "node:path";
import {
  Configuration,
  configurationLayer,
  type VmConfiguration,
  VmError,
} from "../src/configuration.ts";
import { Processes, processesLayer, type ProcessResult } from "../src/processes.ts";
import { withLock, writeAtomic } from "../src/state.ts";
import { Tart, tartLayer } from "../src/tart.ts";
import { makeVm } from "../src/vm.ts";

const configFor = (root: string): VmConfiguration => ({
  root,
  repo: root,
  tart: "tart",
  authPath: join(root, "auth.json"),
  requestedCodex: "latest",
  guestScript: new Uint8Array(),
  fingerprint: "test",
});
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-vm-test-" });
  return { fs, root, config: configFor(root) };
});
const success = (stdout = ""): ProcessResult => ({ stdout, stderr: "", code: 0 });

it.live("serializes only the same VM and releases its complete lock on interruption", () =>
  Effect.gen(function* () {
    const { fs, root, config } = yield* fixture;
    const entered = yield* Deferred.make<void>();
    const holder = yield* withLock(
      "skit-one",
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    ).pipe(Effect.provideService(Configuration, config), Effect.forkScoped);
    yield* Deferred.await(entered);
    const owner = yield* fs.readFileString(join(root, "locks/skit-one.lock"));
    expect(owner).toMatch(/^\d+@\S+ [0-9a-f-]+\n$/);
    const contender = yield* withLock("skit-one", Effect.void).pipe(
      Effect.provideService(Configuration, config),
      Effect.result,
    );
    expect(contender._tag).toBe("Failure");
    yield* withLock("skit-two", Effect.void).pipe(Effect.provideService(Configuration, config));
    yield* Fiber.interrupt(holder);
    expect(yield* fs.exists(join(root, "locks/skit-one.lock"))).toBe(false);
    yield* withLock("skit-one", Effect.void).pipe(Effect.provideService(Configuration, config));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("fails closed on stale ownership and never deletes a replacement owner's lock", () =>
  Effect.gen(function* () {
    const { fs, root, config } = yield* fixture;
    const path = join(root, "locks/skit-one.lock");
    yield* writeAtomic(path, "stopped-owner\n", true);
    const result = yield* withLock("skit-one", Effect.void).pipe(
      Effect.provideService(Configuration, config),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    expect(yield* fs.readFileString(path)).toBe("stopped-owner\n");
    yield* fs.remove(path);
    yield* withLock("skit-one", writeAtomic(path, "replacement-owner\n")).pipe(
      Effect.provideService(Configuration, config),
    );
    expect(yield* fs.readFileString(path)).toBe("replacement-owner\n");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("polls after a disconnected shutdown channel before using forced stop", () =>
  Effect.gen(function* () {
    const { config } = yield* fixture;
    const stopped = yield* Ref.make(false);
    const forced = yield* Ref.make(false);
    const shutdown = yield* Deferred.make<void>();
    const processLayer = Layer.succeed(
      Processes,
      Processes.of({
        run: (_, args) => {
          if (args[0] === "list")
            return Ref.get(stopped).pipe(
              Effect.map((done) =>
                success(
                  JSON.stringify([{ Name: "skit-one", State: done ? "stopped" : "running" }]),
                ),
              ),
            );
          if (args[0] === "stop") return Ref.set(forced, true).pipe(Effect.as(success()));
          return Deferred.succeed(shutdown, undefined).pipe(
            Effect.andThen(Effect.fail(new VmError({ message: "channel closed" }))),
          );
        },
      }),
    );
    const test = Effect.gen(function* () {
      const tart = yield* Tart;
      const fiber = yield* tart.stop("skit-one").pipe(Effect.forkScoped);
      yield* Deferred.await(shutdown);
      yield* Ref.set(stopped, true);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      expect(yield* Ref.get(forced)).toBe(false);
    });
    yield* test.pipe(
      Effect.provide(tartLayer.pipe(Layer.provide(processLayer))),
      Effect.provideService(Configuration, config),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("allows a second session and stop while an interactive process is open", () =>
  Effect.gen(function* () {
    const { config } = yield* fixture;
    const entered = yield* Deferred.make<void>();
    const stopped = yield* Ref.make(false);
    const adapter = Tart.of({
      run: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      state: () => Effect.succeed("running"),
      guest: () => Effect.succeed(success()),
      start: () => Effect.void,
      stop: () => Ref.set(stopped, true),
      job: () => Effect.succeed(success()),
    });
    const test = Effect.gen(function* () {
      const vm = yield* makeVm;
      const first = yield* vm.attach("skit-one", "shell").pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* withLock("skit-one", Effect.void);
      yield* vm.stop("skit-one");
      expect(yield* Ref.get(stopped)).toBe(true);
      yield* Fiber.interrupt(first);
    });
    yield* test.pipe(
      Effect.provideService(Tart, adapter),
      Effect.provideService(Configuration, config),
      Effect.provide(processesLayer),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("suppresses secret subprocess stderr even on a failing exit", () =>
  Effect.gen(function* () {
    const processes = yield* Processes;
    const result = yield* processes
      .run(
        process.execPath,
        ["-e", 'process.stderr.write("credential-sentinel"); process.exit(7)'],
        { secret: true },
      )
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure.message).not.toContain("credential-sentinel");
  }).pipe(Effect.provide(processesLayer), Effect.provide(NodeServices.layer)),
);

it.live("interrupts scoped host processes and their descendants", () =>
  Effect.gen(function* () {
    const { fs, root } = yield* fixture;
    const path = join(root, "pids");
    const processes = yield* Processes;
    const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(path)},process.pid+' '+child.pid); setInterval(()=>{},1000);`;
    const fiber = yield* processes
      .run(process.execPath, ["-e", script], { output: "quiet" })
      .pipe(Effect.forkScoped);
    const pids = yield* fs
      .readFileString(path)
      .pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 500 }));
    yield* Fiber.interrupt(fiber);
    for (const pid of pids.split(" ").map(Number)) {
      const alive = yield* Effect.sync(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      expect(alive).toBe(false);
    }
  }).pipe(Effect.scoped, Effect.provide(processesLayer), Effect.provide(NodeServices.layer)),
);

it.effect("fails boot immediately when the launched Tart process has exited", () =>
  Effect.gen(function* () {
    const { config } = yield* fixture;
    const probes = yield* Ref.make(0);
    const processLayer = Layer.succeed(
      Processes,
      Processes.of({
        run: (_, args) => {
          if (args[0] === "list")
            return Effect.succeed(
              success(JSON.stringify([{ Name: "skit-one", State: "stopped" }])),
            );
          if (args[0] === "exec")
            return Ref.update(probes, (n) => n + 1).pipe(Effect.as(success()));
          return Effect.succeed(success("1000000000\n"));
        },
      }),
    );
    yield* Effect.gen(function* () {
      const tart = yield* Tart;
      const result = yield* tart.start("skit-one").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("exited during boot");
      expect(yield* Ref.get(probes)).toBe(0);
    }).pipe(
      Effect.provide(tartLayer.pipe(Layer.provide(processLayer))),
      Effect.provideService(Configuration, config),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("keeps clone compatibility independent of a shell's CODEX_VERSION", () =>
  Effect.gen(function* () {
    const load = (codex: string) =>
      Effect.gen(function* () {
        return yield* Configuration;
      }).pipe(
        Effect.provide(configurationLayer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ CODEX_VERSION: codex }))),
      );
    const first = yield* load("latest");
    const pinned = yield* load("0.165.0");
    expect(first.fingerprint).toBe(pinned.fingerprint);
    expect(pinned.requestedCodex).toBe("0.165.0");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects malformed auth before boot without exposing decoder input", () =>
  Effect.gen(function* () {
    const { fs, config } = yield* fixture;
    const calls = yield* Ref.make(0);
    const unexpected = () =>
      Ref.update(calls, (n) => n + 1).pipe(
        Effect.andThen(Effect.fail(new VmError({ message: "Unexpected Tart operation." }))),
      );
    const adapter = Tart.of({
      run: unexpected,
      state: unexpected,
      guest: unexpected,
      start: unexpected,
      stop: unexpected,
      job: unexpected,
    });
    yield* Effect.gen(function* () {
      const vm = yield* makeVm;
      for (const value of ['{"credential-sentinel":', "{}", "null"]) {
        yield* fs.writeFileString(config.authPath, value);
        const result = yield* vm.copyAuth("skit-one").pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.message).not.toContain("credential-sentinel");
      }
      expect(yield* Ref.get(calls)).toBe(0);
    }).pipe(
      Effect.provideService(Tart, adapter),
      Effect.provideService(Configuration, config),
      Effect.provide(processesLayer),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("reports an actionable stale lock after a different process is SIGKILLed", () =>
  Effect.gen(function* () {
    const { fs, root, config } = yield* fixture;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          "--experimental-strip-types",
          fileURLToPath(new URL("./fixtures/lock-owner.ts", import.meta.url)),
          root,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "inherit", forceKillAfter: "1 second" },
      ),
    );
    const ready = yield* child.stdout.pipe(Stream.decodeText(), Stream.take(1), Stream.mkString);
    expect(ready).toContain("LOCKED");
    yield* child.kill({ killSignal: "SIGKILL" });
    const result = yield* withLock("skit-crash", Effect.void).pipe(
      Effect.provideService(Configuration, config),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toContain("owner is gone");
      expect(result.failure.message).toContain("rm -- '");
    }
    expect(yield* fs.exists(join(root, "locks/skit-crash.lock"))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
