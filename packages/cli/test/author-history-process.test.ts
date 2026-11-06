import { expect, it } from "@effect/vitest";
import { Clock, Effect, Stream, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import { readAuthorAncestors } from "./helpers/author-history.js";
import { authorLayer, captureWorkspace, storedTreesAt } from "./helpers/author-history.js";
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

/** The latest revision of `workspace` in `home` (an unchanged capture records nothing) and how many revisions lead to it. */
const latest = (workspace: string, home: string) =>
  Effect.gen(function* () {
    const saved = yield* captureWorkspace(workspace);
    const reached = yield* readAuthorAncestors(home, saved.id);
    return { ...saved, recorded: Array.from(reached).length };
  }).pipe(Effect.provide(authorLayer(home)));

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
    // One root revision: a second event would name the first as its parent.
    const saved = yield* latest(a.workspace, a.home);
    expect(saved.revision.parents).toEqual([]);
    expect(saved.recorded).toBe(1);
    expect(yield* storedTreesAt(a.home)).toHaveLength(1);
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
    yield* Stream.make(Buffer.from("release\n")).pipe(Stream.run(held.stdin));
    expect(yield* held.exitCode).toBe(0);
    const recovered = yield* spawner.spawn(command("record", a.workspace, a.home));
    expect(yield* recovered.exitCode).toBe(0);
    // Only the held recording saved a revision; the busy one and the recovery added none.
    const saved = yield* latest(a.workspace, a.home);
    expect(saved.revision.parents).toEqual([]);
    expect(saved.recorded).toBe(1);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.live("a fresh process resumes after SIGKILL during an uncommitted observation", () =>
  Effect.gen(function* () {
    const { a } = yield* makeAuthorSyncWorld();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* a.edit("notes/a.txt", "A");
    const first = yield* spawner.spawn(command("record", a.workspace, a.home));
    expect(yield* first.exitCode).toBe(0);
    const original = yield* latest(a.workspace, a.home);
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
    const killedAt = yield* Clock.currentTimeMillis;
    // No finalizers ran in the killed process. SQLite must roll back and release its lock.
    expect(yield* storedTreesAt(a.home)).toHaveLength(2);
    const resumed = yield* spawner.spawn(command("record", a.workspace, a.home));
    expect(yield* resumed.exitCode).toBe(0);
    // The resumed process recorded B after the original; the killed one committed nothing.
    const saved = yield* latest(a.workspace, a.home);
    expect(saved.revision.parents).toEqual([original.id]);
    expect(saved.revision.author.at).toBeGreaterThanOrEqual(killedAt);
    expect(saved.recorded).toBe(2);
    expect(saved.revision.author.device).toBe(original.revision.author.device);
  }).pipe(Effect.provide(testPlatformLayer)),
);
