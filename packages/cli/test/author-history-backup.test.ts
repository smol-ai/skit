import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { join } from "node:path";
import { systemError } from "effect/PlatformError";
import { authorLayer, refreshWorkspace } from "../src/platform/author-sync-fixture/history.js";
import { makeAuthorSyncWorld } from "../src/platform/author-sync-fixture/world.js";
import { testPlatformLayer } from "./helpers/platform.js";

for (const connection of ["first", "connected"] as const)
  it.effect.each(["file", "dangling"] as const)(
    `backs up a ${connection} workspace's %s symlink without applying or following it`,
    (targetKind) =>
      Effect.gen(function* () {
        const world = yield* makeAuthorSyncWorld();
        if (connection === "connected") yield* world.connect();
        const fs = yield* FileSystem.FileSystem;
        const external = yield* fs.makeTempDirectoryScoped({ prefix: "skit-outside-author-" });
        const target = join(external, targetKind);
        if (targetKind === "file")
          yield* fs.writeFileString(target, "outside bytes never uploaded");
        const pointer = join(world.a.workspace, "pointer");
        yield* fs.symlink(target, pointer);
        const current = yield* world.server.current();
        const revisions = yield* world.server.revisions();
        const entries = yield* fs.readDirectory(world.a.workspace);
        const preview = yield* world.a
          .startSync(connection === "first", false)
          .pipe(Effect.flatMap(Fiber.join), Effect.flip);
        expect(preview).toMatchObject({
          _tag: "TreeError",
          reason: { _tag: "InvalidSymlink", path: "pointer" },
        });
        expect(yield* world.server.revisions()).toEqual(revisions);
        expect(yield* fs.readDirectory(world.a.workspace)).toEqual(entries);
        expect(yield* Effect.flip(world.a.sync(connection === "first"))).toMatchObject({
          _tag: "TreeError",
          reason: { _tag: "InvalidSymlink", path: "pointer" },
        });
        const observation = yield* refreshWorkspace(world.a.workspace).pipe(
          Effect.provide(authorLayer(world.a.home)),
        );
        const backedUp = (yield* world.server.revisions()).find(({ id }) => id === observation.id);
        expect(backedUp?.tree.find(({ path }) => path === "pointer")).toEqual({
          path: "pointer",
          kind: "symlink",
          target,
        });
        expect(
          backedUp?.tree.some(
            (entry) =>
              entry.kind === "file" &&
              new TextDecoder().decode(entry.bytes).includes("outside bytes never uploaded"),
          ),
        ).toBe(false);
        expect(yield* world.server.current()).toBe(current);
        expect(yield* fs.readLink(pointer)).toBe(target);
        if (targetKind === "file")
          expect(yield* fs.readFileString(target)).toBe("outside bytes never uploaded");
        const events = yield* world.server.events();
        expect(yield* Effect.flip(world.a.sync())).toMatchObject({ _tag: "TreeError" });
        expect(yield* world.server.events()).toEqual(events);
        expect(
          (yield* world.server.revisions()).filter(({ id }) => id === observation.id),
        ).toHaveLength(1);
      }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );

it.effect.each(["first", "connected"] as const)(
  "recovers a lost raw-backup response for a %s workspace that cannot be normalized",
  (connection) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      if (connection === "connected") yield* world.connect();
      const fs = yield* FileSystem.FileSystem;
      const pointer = join(world.a.workspace, "pointer");
      yield* fs.symlink("missing-target", pointer);
      const current = yield* world.server.current();
      yield* world.server.dropNextResponse("a", "after-post");
      expect(yield* Effect.flip(world.a.sync(connection === "first"))).toMatchObject({
        _tag: "RegistryUnreachable",
      });
      const observation = yield* refreshWorkspace(world.a.workspace).pipe(
        Effect.provide(authorLayer(world.a.home)),
      );
      expect(
        (yield* world.server.revisions()).filter(({ id }) => id === observation.id),
      ).toHaveLength(1);
      yield* world.a.restart();
      expect(yield* Effect.flip(world.a.sync())).toMatchObject({
        _tag: "TreeError",
        reason: { _tag: "InvalidSymlink", path: "pointer" },
      });
      expect(
        (yield* world.server.revisions()).filter(({ id }) => id === observation.id),
      ).toHaveLength(1);
      expect(yield* world.server.current()).toBe(current);
      expect(yield* fs.readLink(pointer)).toBe("missing-target");
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

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
          yield* refreshWorkspace(world.a.workspace).pipe(
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
      const observation = yield* refreshWorkspace(world.a.workspace).pipe(
        Effect.provide(authorLayer(world.a.home)),
      );
      const current = yield* world.server.current();
      if (interruption === "lost-response") yield* world.server.dropNextResponse("a", "after-post");
      const fs = yield* FileSystem.FileSystem;
      let refused = false;
      const result = yield* world.a.sync().pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: Effect.fn(function* (from: string, to: string) {
            if (
              interruption === "lost-acknowledgement" &&
              !refused &&
              to === join(world.a.home, "author-sync.json")
            ) {
              const document = yield* Schema.decodeEffect(
                Schema.fromJsonString(
                  Schema.Struct({
                    backups: Schema.optionalKey(
                      Schema.Record(
                        Schema.String,
                        Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
                      ),
                    ),
                  }),
                ),
              )(yield* fs.readFileString(from)).pipe(Effect.orDie);
              // The chain can contain older unacknowledged observations. Interrupt the save
              // that acknowledges this edit, after its POST has actually succeeded.
              if (
                Object.values(document.backups ?? {}).some((entries) =>
                  Object.values(entries).includes(observation.id),
                )
              ) {
                refused = true;
                return yield* systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: to,
                });
              }
            }
            return yield* fs.rename(from, to);
          }),
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
