import { describe, expect, it } from "@effect/vitest";
import { Clock, Deferred, Duration, Effect, Fiber, FileSystem, Queue, Ref, Stream } from "effect";
import { systemError } from "effect/PlatformError";
import { join } from "node:path";
import type { AuthorWatchEvent } from "@smolai/skit-core/author";
import { makeAuthorSyncWorld } from "../src/platform/author-sync-fixture/world.js";
import { testPlatformLayer } from "./helpers/platform.js";

describe("skit author watch", () => {
  describe("If the watched folder is swapped for a different one, watch refuses it and writes nothing into it.", () => {
    it.live("watch refuses WatchedRootReplaced after its folder is replaced", () =>
      Effect.gen(function* () {
        const world = yield* makeAuthorSyncWorld();
        yield* world.connect();
        const fs = yield* FileSystem.FileSystem;
        const events = yield* Queue.unbounded<AuthorWatchEvent>();
        const watcher = yield* world.a
          .startWatch((event) => Queue.offer(events, event).pipe(Effect.asVoid))
          .pipe(Effect.provideService(FileSystem.FileSystem, { ...fs, watch: () => Stream.never }));
        yield* Stream.fromQueue(events).pipe(
          Stream.filter((event) => event.event === "installation"),
          Stream.take(1),
          Stream.runDrain,
        );
        const moved = join(world.a.home, "original-workspace");
        yield* fs.rename(world.a.workspace, moved);
        yield* fs.makeDirectory(world.a.workspace);
        yield* fs.writeFileString(join(world.a.workspace, "sentinel.txt"), "replacement contents");
        const failures = yield* Stream.fromQueue(events).pipe(
          Stream.filter((event) => event.event === "retrying" && event.operation === "observe"),
          Stream.take(1),
          Stream.runCollect,
        );
        expect(failures).toMatchObject([
          {
            event: "retrying",
            operation: "observe",
            failure: {
              _tag: "AuthorWorkspaceUnsafe",
              path: world.a.workspace,
              reason: { _tag: "WatchedRootReplaced" },
            },
          },
        ]);
        yield* Fiber.interrupt(watcher);
        expect(yield* fs.readDirectory(world.a.workspace)).toEqual(["sentinel.txt"]);
        expect(yield* fs.readFileString(join(world.a.workspace, "sentinel.txt"))).toBe(
          "replacement contents",
        );
        expect(yield* fs.readFileString(join(moved, "skills/review/SKILL.md"))).toContain(
          "# Review",
        );
      }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
    );
  });
  describe("Watch retries a failed installation without another edit.", () => {
    it.live(
      "watch reports repeated installation failure once and recovers without another edit",
      () =>
        Effect.gen(function* () {
          const world = yield* makeAuthorSyncWorld();
          yield* world.connect();
          yield* world.a.registerAndEnable();
          const path = "skills/review/SKILL.md";
          const content = (yield* world.a.read(path)).replace("# Review", "# Retry installation");
          yield* world.a.edit(path, content);
          const fs = yield* FileSystem.FileSystem;
          const failing = yield* Ref.make(true);
          const clock = yield* Clock.Clock;
          const passes = yield* Queue.unbounded<void>();
          const resume = yield* Queue.unbounded<void>();
          const events = yield* Queue.unbounded<AuthorWatchEvent>();
          const trace: AuthorWatchEvent[] = [];
          const failure = systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: join(world.a.home, "machine.json"),
          });
          const watcher = yield* world.a
            .startWatch((event) =>
              Effect.sync(() => {
                trace.push(event);
              }).pipe(Effect.andThen(Queue.offer(events, event)), Effect.asVoid),
            )
            .pipe(
              Effect.provideService(Clock.Clock, {
                currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
                currentTimeMillis: clock.currentTimeMillis,
                currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
                currentTimeNanos: clock.currentTimeNanos,
                monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
                monotonicTimeNanos: clock.monotonicTimeNanos,
                // The foreground loop sleeps after install and sync. Gate that idle
                // delay so two completed attempts are proven without counting reads
                // that the independent history observer also performs.
                sleep: (duration) =>
                  Duration.toMillis(duration) === 3_000
                    ? Queue.offer(passes, undefined).pipe(
                        Effect.andThen(Queue.take(resume)),
                        Effect.asVoid,
                      )
                    : clock.sleep(duration),
              }),
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                watch: () => Stream.never,
                readFileString: (path, encoding) =>
                  Effect.gen(function* () {
                    if (path === join(world.a.home, "machine.json") && (yield* Ref.get(failing)))
                      return yield* failure;
                    return yield* fs.readFileString(path, encoding);
                  }),
              }),
            );
          yield* Stream.fromQueue(events).pipe(
            Stream.filter((event) => event.event === "retrying" && event.operation === "install"),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* Queue.take(passes);
          yield* Queue.offer(resume, undefined);
          yield* Queue.take(passes);
          expect(
            trace.filter((event) => event.event === "retrying" && event.operation === "install"),
          ).toHaveLength(1);
          yield* Ref.set(failing, false);
          yield* Queue.offer(resume, undefined);
          const recovery = yield* Stream.fromQueue(events).pipe(
            Stream.filter((event) => event.event === "recovered" && event.operation === "install"),
            Stream.take(1),
            Stream.runCollect,
          );
          expect(recovery).toEqual([{ event: "recovered", operation: "install" }]);
          expect(
            trace.filter((event) => event.event === "retrying" && event.operation === "install"),
          ).toMatchObject([
            {
              event: "retrying",
              operation: "install",
              failure: {
                _tag: "MachineSettingsUnusable",
                reason: { _tag: "ReadFailed" },
              },
            },
          ]);
          expect(yield* world.a.installed("review/SKILL.md")).toContain("# Retry installation");
          expect(
            trace.some((event) => event.event === "installation" && event.status === "updated"),
          ).toBe(true);
          yield* Fiber.interrupt(watcher);
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
    );
  });
  describe("Pending removals finish on periodic passes without a file event.", () => {
    it.live(
      "watch keeps a pending input until confirmation, then removes it without another edit",
      () =>
        Effect.gen(function* () {
          const world = yield* makeAuthorSyncWorld();
          yield* world.connect();
          const path = "skills/review/notes.txt";
          yield* world.a.edit(path, "an installed input");
          yield* world.a.registerAndEnable();
          const fs = yield* FileSystem.FileSystem;
          const installed = join(world.a.home, "..", "agents/review/notes.txt");
          expect(yield* fs.readFileString(installed)).toBe("an installed input");
          const clock = yield* Clock.Clock;
          let elapsed = 0n;
          const passes = yield* Queue.unbounded<void>();
          const resume = yield* Queue.unbounded<void>();
          const events = yield* Queue.unbounded<AuthorWatchEvent>();
          const watcher = yield* world.a
            .startWatch((event) => Queue.offer(events, event).pipe(Effect.asVoid))
            .pipe(
              Effect.provideService(FileSystem.FileSystem, { ...fs, watch: () => Stream.never }),
              Effect.provideService(Clock.Clock, {
                currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
                currentTimeMillis: clock.currentTimeMillis,
                currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
                currentTimeNanos: clock.currentTimeNanos,
                monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe() + elapsed,
                monotonicTimeNanos: clock.monotonicTimeNanos.pipe(
                  Effect.map((time) => time + elapsed),
                ),
                // Gate foreground idle time; the real one-second observer still rescans.
                sleep: (duration) =>
                  Duration.toMillis(duration) === 3_000
                    ? Queue.offer(passes, undefined).pipe(
                        Effect.andThen(Queue.take(resume)),
                        Effect.asVoid,
                      )
                    : clock.sleep(duration),
              }),
            );
          yield* Queue.take(passes);
          yield* world.a.remove(path);
          yield* Stream.fromQueue(events).pipe(
            Stream.filter((event) => event.event === "saved_locally" && event.paths.includes(path)),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* Queue.offer(resume, undefined);
          const pending = yield* Stream.fromQueue(events).pipe(
            Stream.filter(
              (event) =>
                event.event === "installation" &&
                event.issues.some((issue) => issue._tag === "InputRemovalPending"),
            ),
            Stream.take(1),
            Stream.runCollect,
          );
          expect(pending).toMatchObject([{ event: "installation", status: "unchanged" }]);
          expect(yield* fs.readFileString(installed)).toBe("an installed input");
          yield* Queue.take(passes);
          // Advance only the removal check's monotonic time, avoiding a ten-second wait.
          elapsed += 11_000_000_000n;
          yield* Queue.offer(resume, undefined);
          yield* Stream.fromQueue(events).pipe(
            Stream.filter((event) => event.event === "installation" && event.status === "updated"),
            Stream.take(1),
            Stream.runDrain,
          );
          expect(yield* fs.exists(installed)).toBe(false);
          expect(yield* world.a.exists(path)).toBe(false);
          yield* Fiber.interrupt(watcher);
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
    );
  });
  describe("Watch restarts a failed file-event stream and saves edits after events return.", () => {
    it.live(
      "watch restarts a failed file-event stream and reports recovery when events return",
      () =>
        Effect.gen(function* () {
          const world = yield* makeAuthorSyncWorld();
          yield* world.connect();
          const fs = yield* FileSystem.FileSystem;
          const events = yield* Queue.unbounded<AuthorWatchEvent>();
          const saved = yield* Deferred.make<AuthorWatchEvent>();
          const hints = yield* Queue.unbounded<FileSystem.WatchEvent>();
          const failure = systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "watch",
            pathOrDescriptor: world.a.workspace,
          });
          let subscriptions = 0;
          const watcher = yield* world.a
            .startWatch((event) =>
              Effect.gen(function* () {
                if (event.event === "saved_locally" && event.paths.includes("event.txt"))
                  yield* Deferred.succeed(saved, event);
                yield* Queue.offer(events, event);
              }),
            )
            .pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                watch: () =>
                  Stream.suspend(() => {
                    subscriptions++;
                    return subscriptions === 1 ? Stream.fail(failure) : Stream.fromQueue(hints);
                  }),
              }),
            );
          const retry = yield* Stream.fromQueue(events).pipe(
            Stream.filter((event) => event.event === "retrying" && event.operation === "events"),
            Stream.take(1),
            Stream.runCollect,
          );
          expect(retry).toEqual([{ event: "retrying", operation: "events", failure }]);
          // The retry waits one second before subscribing again. This hint stays queued until then.
          yield* world.a.edit("event.txt", "saved after event recovery");
          yield* Queue.offer(hints, { _tag: "Update", path: "event.txt" });
          const recovered = yield* Stream.fromQueue(events).pipe(
            Stream.filter((event) => event.event === "recovered" && event.operation === "events"),
            Stream.take(1),
            Stream.runCollect,
          );
          expect(recovered).toEqual([{ event: "recovered", operation: "events" }]);
          expect(subscriptions).toBe(2);
          expect(yield* Deferred.await(saved)).toMatchObject({
            event: "saved_locally",
            paths: ["event.txt"],
          });
          yield* Fiber.interrupt(watcher);
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
    );
  });
});
