import { expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Ref, Schedule } from "effect";
import { join } from "node:path";
import type { AuthorWatchEvent } from "@smolai/skit-core/author";
import { testPlatformLayer } from "./helpers/platform.js";
import { makeAuthorSyncWorld } from "./helpers/author-sync-world.js";
import { storedTreesAt } from "./helpers/author-history.js";

it.live(
  "native watch observes an atomic save and two foreground devices converge without manual sync",
  () =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      yield* world.connect();
      yield* world.a.registerAndEnable();
      yield* world.b.registerAndEnable();
      // The declared explicit invocation policy adds native metadata to installed SKILL.md.
      const expectedInstalled = (yield* world.b.installed("review/SKILL.md")).replace(
        "# Review",
        "# Automatically synchronized",
      );
      const fs = yield* FileSystem.FileSystem;
      const observed: AuthorWatchEvent[] = [];
      yield* world.a.startWatch(() => Effect.void);
      yield* world.b.startWatch((event) =>
        Effect.sync(() => {
          observed.push(event);
        }),
      );
      const content =
        "---\nname: review\ndescription: Review code.\n---\n# Automatically synchronized\n";
      const target = join(world.a.workspace, "skills/review/SKILL.md");
      yield* fs.writeFileString(`${target}.tmp`, content);
      yield* fs.rename(`${target}.tmp`, target);
      yield* world.b.read("skills/review/SKILL.md").pipe(
        Effect.filterOrFail(
          (value) => value === content,
          () => new Error("second workspace has not converged"),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }),
      );
      yield* world.b.installed("review/SKILL.md").pipe(
        Effect.filterOrFail(
          (value) => value === expectedInstalled,
          () =>
            new Error(
              `second installed copy has not advanced: ${JSON.stringify(observed.slice(-12))}`,
            ),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }),
      );
      expect(yield* world.a.installed("review/SKILL.md")).toEqual(expectedInstalled);
      expect(yield* world.missing(yield* world.copies())).toEqual([]);
      expect(
        (yield* world.server.revisions()).some(({ tree }) =>
          tree.some(
            (entry) =>
              entry.kind === "file" &&
              entry.path === "skills/review/SKILL.md" &&
              Buffer.from(entry.bytes).toString() === content,
          ),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testPlatformLayer)),
  { timeout: 25_000 },
);

it.live(
  "local observations continue while the Registry stalls and stopping watch releases its sync",
  () =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      yield* world.connect();
      const fs = yield* FileSystem.FileSystem;
      const gate = yield* world.server.gate("a", "after-post");
      const ready = yield* Deferred.make<void>();
      const events = yield* Ref.make<ReadonlyArray<AuthorWatchEvent>>([]);
      yield* world.a.startWatch((event) =>
        Ref.update(events, (items) => [...items, event]).pipe(
          Effect.andThen(
            event.event === "watching" ? Deferred.succeed(ready, undefined) : Effect.void,
          ),
          Effect.asVoid,
        ),
      );
      yield* Deferred.await(ready);
      yield* fs.writeFileString(join(world.a.workspace, "offline.txt"), "first offline edit");
      yield* gate.reached();
      yield* fs.writeFileString(join(world.a.workspace, "offline.txt"), "second offline edit");
      yield* storedTreesAt(world.a.home).pipe(
        Effect.filterOrFail(
          (trees) =>
            trees.some(({ tree }) =>
              tree.some(
                (entry) =>
                  entry.kind === "file" &&
                  entry.path === "offline.txt" &&
                  Buffer.from(entry.bytes).toString() === "second offline edit",
              ),
            ),
          () => new Error("new edit has not been saved while network waits"),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 80 }),
      );
      yield* world.a.restart();
      yield* gate.release();
      expect((yield* world.a.sync()).status).toMatch(/pushed|merged|up_to_date/);
    }).pipe(Effect.scoped, Effect.provide(testPlatformLayer)),
  { timeout: 25_000 },
);

it.live(
  "watch reports an offline transition once and reports recovery without idle sync messages",
  () =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      yield* world.connect();
      yield* world.a.registerAndEnable();
      yield* world.server.setOnline("a", false);
      const events = yield* Ref.make<readonly AuthorWatchEvent[]>([]);
      yield* world.a.startWatch((event) => Ref.update(events, (current) => [...current, event]));
      yield* Ref.get(events).pipe(
        Effect.filterOrFail(
          (trace) =>
            trace.some((event) => event.event === "retrying" && event.operation === "sync"),
          () => new Error("Offline event has not arrived"),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 60 }),
      );
      yield* Effect.sleep("6500 millis");
      expect(
        (yield* Ref.get(events)).filter(
          (event) => event.event === "retrying" && event.operation === "sync",
        ),
      ).toHaveLength(1);
      yield* world.server.setOnline("a", true);
      yield* Ref.get(events).pipe(
        Effect.filterOrFail(
          (trace) =>
            trace.some((event) => event.event === "recovered" && event.operation === "sync"),
          () => new Error("Recovery event has not arrived"),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 60 }),
      );
      yield* Effect.sleep("3500 millis");
      const trace = yield* Ref.get(events);
      expect(
        trace.filter((event) => event.event === "recovered" && event.operation === "sync"),
      ).toHaveLength(1);
      expect(
        trace.some((event) => event.event === "sync" && event.result.status === "up_to_date"),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testPlatformLayer)),
  { timeout: 30_000 },
);
