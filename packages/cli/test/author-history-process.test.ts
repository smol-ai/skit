import { expect, it } from "@effect/vitest";
import { Effect, Stream, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import { loadAuthorHistory, loadStoredTrees } from "../src/workflows/author/history.js";
import { makeAuthorSyncWorld } from "./helpers/author-sync-world.js";
import { testPlatformLayer } from "./helpers/platform.js";

const worker = join(process.cwd(), "dist/test/fixtures/author-history-worker.js");
const command = (mode: "record" | "pause" | "hold" | "contend", root: string, home: string) =>
  ChildProcess.make(process.execPath, ["--no-warnings", worker, mode, root, home], {
    stdout: "pipe",
    stderr: "inherit",
    stdin: "pipe",
  });

// Worker protocol, separate from SKIT's user-facing CLI output.
const WorkerEvent = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.Literals(["paused", "retrying", "busy"]),
    code: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  }),
);
const eventsFrom = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  count = Number.MAX_SAFE_INTEGER,
) =>
  handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.take(count),
    Stream.mapEffect((line) => Schema.decodeUnknownEffect(WorkerEvent)(line)),
    Stream.runCollect,
  );

it.live("independent recording processes deduplicate the same new observation", () =>
  Effect.gen(function* () {
    const { a } = yield* makeAuthorSyncWorld();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* a.edit("notes/a.txt", "shared tree");
    const first = yield* spawner.spawn(command("hold", a.workspace, a.home));
    expect(yield* eventsFrom(first, 1)).toEqual([{ event: "paused" }]);
    const fs = yield* FileSystem.FileSystem;
    for (const name of ["journal.sqlite", "journal.sqlite-wal", "journal.sqlite-shm"])
      expect((yield* fs.stat(join(a.home, "history", name))).mode & 0o777).toBe(0o600);
    const second = yield* spawner.spawn(command("contend", a.workspace, a.home));
    // A second connection attempt proves the first met the held write lock.
    expect(yield* eventsFrom(second, 1)).toEqual([{ event: "retrying" }]);
    expect(yield* second.isRunning).toBe(true);
    yield* Stream.make(Buffer.from("release\n")).pipe(Stream.run(first.stdin));
    expect(yield* first.exitCode).toBe(0);
    expect(yield* second.exitCode).toBe(0);
    expect(yield* loadAuthorHistory(a.workspace, a.home)).toHaveLength(1);
    expect(yield* loadStoredTrees(a.home)).toHaveLength(1);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.live("a held write lock exhausts bounded retries as busy, then recording recovers", () =>
  Effect.gen(function* () {
    const { a } = yield* makeAuthorSyncWorld();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const held = yield* spawner.spawn(command("hold", a.workspace, a.home));
    expect(yield* eventsFrom(held, 1)).toEqual([{ event: "paused" }]);
    const blocked = yield* spawner.spawn(command("contend", a.workspace, a.home));
    // Keep the first transaction open until the actual retry budget is exhausted.
    expect(yield* eventsFrom(blocked)).toEqual([
      { event: "retrying" },
      { event: "busy", code: "CONFLICT", retryable: true },
    ]);
    expect(yield* blocked.exitCode).toBe(0);
    expect(yield* loadAuthorHistory(a.workspace, a.home)).toEqual([]);
    yield* Stream.make(Buffer.from("release\n")).pipe(Stream.run(held.stdin));
    expect(yield* held.exitCode).toBe(0);
    const recovered = yield* spawner.spawn(command("record", a.workspace, a.home));
    expect(yield* recovered.exitCode).toBe(0);
    expect(yield* loadAuthorHistory(a.workspace, a.home)).toHaveLength(1);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.live("a fresh process resumes after SIGKILL during an uncommitted observation", () =>
  Effect.gen(function* () {
    const { a } = yield* makeAuthorSyncWorld();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* a.edit("notes/a.txt", "A");
    const first = yield* spawner.spawn(command("record", a.workspace, a.home));
    expect(yield* first.exitCode).toBe(0);
    const original = yield* loadAuthorHistory(a.workspace, a.home);
    yield* a.edit("notes/a.txt", "B");
    const paused = yield* spawner.spawn(command("pause", a.workspace, a.home));
    const ready = yield* eventsFrom(paused, 1);
    expect(Array.from(ready)).toEqual([{ event: "paused" }]);
    yield* paused.kill({ killSignal: "SIGKILL" });
    expect(yield* Effect.flip(paused.exitCode)).toMatchObject({
      _tag: "PlatformError",
      reason: {
        method: "exitCode",
        cause: { message: "Process interrupted due to receipt of signal: 'SIGKILL'" },
      },
    });
    expect(yield* paused.isRunning).toBe(false);
    // No finalizers ran in the killed process. SQLite must roll back and release its lock.
    expect(yield* loadAuthorHistory(a.workspace, a.home)).toEqual(original);
    expect(yield* loadStoredTrees(a.home)).toHaveLength(2);
    const resumed = yield* spawner.spawn(command("record", a.workspace, a.home));
    expect(yield* resumed.exitCode).toBe(0);
    const events = yield* loadAuthorHistory(a.workspace, a.home);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events[0]?.revision.author.device).toBe(events[1]?.revision.author.device);
  }).pipe(Effect.provide(testPlatformLayer)),
);
