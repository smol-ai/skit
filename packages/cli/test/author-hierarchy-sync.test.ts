import { expect, it } from "@effect/vitest";
import { Cause, Effect, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { join } from "node:path";
import { History } from "@smolai/skit-core";
import { authorLayer, captureWorkspace } from "./helpers/author-history.js";
import { makeAuthorSyncWorld } from "./helpers/author-sync-world.js";
import { testPlatformLayer } from "./helpers/platform.js";

for (const winner of ["file", "directory"] as const)
  for (const first of ["a", "b"] as const)
    it.effect(`${winner} wins a structural overlap with ${first} syncing first`, () =>
      Effect.gen(function* () {
        const world = yield* makeAuthorSyncWorld();
        yield* world.connect();
        yield* world.a.edit("ours.txt", "independent ours", "remote");
        yield* world.b.edit("theirs.txt", "independent theirs", "remote");
        const older = winner === "file" ? world.b : world.a;
        const newer = winner === "file" ? world.a : world.b;
        const edit = (device: typeof world.a) =>
          device.name === "a"
            ? device.edit("notes", "file side", "remote")
            : device.edit("notes/a.txt", "directory side", "remote");
        yield* edit(older);
        yield* captureWorkspace(older.workspace).pipe(Effect.provide(authorLayer(older.home)));
        yield* TestClock.adjust("1 minute");
        yield* edit(newer);
        yield* captureWorkspace(newer.workspace).pipe(Effect.provide(authorLayer(newer.home)));
        yield* world[first].sync();
        const second = first === "a" ? "b" : "a";
        const merged = yield* world[second].sync();
        expect(merged).toMatchObject({
          status: "merged",
          choices: [
            {
              path: "notes",
              kind: "both_modified",
              kept: newer.name === second ? "local" : "remote",
            },
          ],
        });
        for (let retry = 0; retry < 2; retry++) {
          yield* world.a.sync();
          yield* world.b.sync();
        }
        const path = winner === "file" ? "notes" : "notes/a.txt";
        expect(yield* world.a.read(path)).toBe(winner === "file" ? "file side" : "directory side");
        expect(yield* world.a.read("ours.txt")).toBe("independent ours");
        expect(yield* world.a.read("theirs.txt")).toBe("independent theirs");
        expect(
          (yield* world.a.files()).map(({ path, bytes }) => ({ path, bytes: [...bytes] })),
        ).toEqual((yield* world.b.files()).map(({ path, bytes }) => ({ path, bytes: [...bytes] })));
        expect(yield* world.missing(yield* world.copies())).toEqual([]);
        expect(
          (yield* world.server.revisions()).every(
            ({ tree }) => History.treePathIssue(tree) === undefined,
          ),
        ).toBe(true);
      }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
    );

for (const direction of ["file-to-directory", "directory-to-file"] as const)
  it.effect(
    `structural editor changes during interrupted ${direction} stay writable and converge`,
    () =>
      Effect.gen(function* () {
        const world = yield* makeAuthorSyncWorld();
        const fs = yield* FileSystem.FileSystem;
        const initial = direction === "file-to-directory" ? "notes" : "notes/a.txt";
        yield* world.a.edit(initial, "original", "remote");
        yield* world.connect();
        yield* fs.remove(join(world.b.workspace, "notes"), { recursive: true });
        const downloaded = direction === "file-to-directory" ? "notes/a.txt" : "notes";
        yield* world.b.edit(downloaded, "remote change", "remote");
        yield* world.b.sync();
        let stopped = false;
        const result = yield* Effect.exit(
          world.a.sync().pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              remove: (path, options) =>
                Effect.gen(function* () {
                  yield* fs.remove(path, options);
                  if (!stopped && path === join(world.a.workspace, initial)) {
                    stopped = true;
                    return yield* Effect.die("process stopped after removing the predecessor");
                  }
                }),
            }),
          ),
        );
        expect(
          result._tag,
          result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
        ).toBe("Failure");
        expect(stopped).toBe(true);
        yield* world.a.restart();
        yield* TestClock.adjust("1 minute");
        if (direction === "directory-to-file")
          yield* fs.remove(join(world.a.workspace, "notes"), { recursive: true });
        const edited = direction === "file-to-directory" ? "notes/own.txt" : "notes";
        yield* world.a.edit(edited, "editor change", "remote");
        for (let retry = 0; retry < 2; retry++) {
          yield* world.a.sync();
          yield* world.b.sync();
        }
        expect(yield* world.a.read(edited)).toBe("editor change");
        if (direction === "file-to-directory")
          expect(yield* world.a.read(downloaded)).toBe("remote change");
        expect(yield* world.missing(yield* world.copies())).toEqual([]);
        expect(
          (yield* world.server.revisions()).every(
            ({ tree }) => History.treePathIssue(tree) === undefined,
          ),
        ).toBe(true);
        expect(
          (yield* world.a.files()).map(({ path, bytes }) => ({ path, bytes: [...bytes] })),
        ).toEqual((yield* world.b.files()).map(({ path, bytes }) => ({ path, bytes: [...bytes] })));
      }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );
