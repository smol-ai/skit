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
      const fs = yield* FileSystem.FileSystem;
      yield* world.a.startWatch(() => Effect.void);
      yield* world.b.startWatch(() => Effect.void);
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
