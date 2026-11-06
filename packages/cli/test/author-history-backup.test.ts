import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { join } from "node:path";
import { systemError } from "effect/PlatformError";
import { authorLayer, captureWorkspace } from "./helpers/author-history.js";
import { makeAuthorSyncWorld } from "./helpers/author-sync-world.js";
import { testPlatformLayer } from "./helpers/platform.js";

it.effect(
  "reconnect backs up each offline A-B-A observation without making the old edits current",
  () =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      yield* world.connect();
      yield* world.server.setOnline("a", false);
      const observations = [];
      for (const bytes of ["A", "B", "A"]) {
        yield* TestClock.adjust("1 second");
        yield* world.a.edit("offline.txt", bytes, "remote");
        observations.push(
          yield* captureWorkspace(world.a.workspace).pipe(
            Effect.provide(authorLayer(world.a.home)),
          ),
        );
      }
      expect(observations[0]?.treeHash).toBe(observations[2]?.treeHash);
      expect(observations[0]?.id).not.toBe(observations[2]?.id);
      expect(yield* Effect.result(world.a.sync())).toMatchObject({ _tag: "Failure" });
      yield* world.a.restart();
      yield* world.server.setOnline("a", true);
      const current = yield* world.server.current();
      const gate = yield* world.server.gate("a", "after-post");
      const sync = yield* world.a.startSync();
      yield* gate.reached();
      // Archiving an older observation must not replace the server's current content.
      expect(yield* world.server.current()).toBe(current);
      yield* gate.release();
      yield* Fiber.join(sync);
      const revisions = yield* world.server.revisions();
      for (const observation of observations)
        expect(revisions.find(({ id }) => id === observation.id)?.revision).toEqual(
          observation.revision,
        );
      expect(yield* world.server.current()).not.toBe(observations[1]?.id);
      yield* world.b.sync();
      expect(yield* world.b.read("offline.txt")).toBe("A");
      expect(yield* world.missing(yield* world.copies())).toEqual([]);
      const completedRevisions = yield* world.server.revisions();
      const posts = (yield* world.server.events()).filter((event) =>
        event.endsWith(":before-post"),
      );
      yield* world.a.sync();
      yield* world.a.sync();
      expect(
        (yield* world.server.events()).filter((event) => event.endsWith(":before-post")),
      ).toEqual(posts);
      expect(yield* world.server.revisions()).toEqual(completedRevisions);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect.each(["lost-response", "lost-acknowledgement"] as const)(
  "resumes an offline backup after %s without duplicating the accepted observation",
  (interruption) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      yield* world.connect();
      yield* TestClock.adjust("1 second");
      yield* world.a.edit("notes.txt", "not valid Skill metadata, still backed up", "remote");
      const observation = yield* captureWorkspace(world.a.workspace).pipe(
        Effect.provide(authorLayer(world.a.home)),
      );
      const current = yield* world.server.current();
      if (interruption === "lost-response") yield* world.server.dropNextResponse("a", "after-post");
      const fs = yield* FileSystem.FileSystem;
      let refused = false;
      const result = yield* world.a.sync().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) => {
            if (
              interruption === "lost-acknowledgement" &&
              !refused &&
              to === join(world.a.home, "sync-bindings.json")
            ) {
              refused = true;
              return Effect.fail(
                systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: to,
                }),
              );
            }
            return fs.rename(from, to);
          },
        }),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(refused).toBe(interruption === "lost-acknowledgement");
      expect(yield* world.server.current()).toBe(current);
      expect(
        (yield* world.server.revisions()).filter(({ id }) => id === observation.id),
      ).toHaveLength(1);
      yield* world.a.restart();
      yield* world.a.sync();
      expect(
        (yield* world.server.revisions()).filter(({ id }) => id === observation.id),
      ).toHaveLength(1);
      expect(yield* world.a.read("notes.txt")).toBe("not valid Skill metadata, still backed up");
      expect(yield* world.missing(yield* world.copies())).toEqual([]);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
