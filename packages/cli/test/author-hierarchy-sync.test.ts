import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { join } from "node:path";
import * as History from "@smolai/skit-core/history";
import { authorLayer, refreshWorkspace } from "../src/platform/author-sync-fixture/history.js";
import { makeAuthorSyncWorld } from "../src/platform/author-sync-fixture/world.js";
import { testPlatformLayer } from "./helpers/platform.js";

describe("skit author sync", () => {
  describe("Combining edits", () => {
    describe("An unrelated later edit does not renew an older conflicting file.", () => {
      for (const first of ["a", "b"] as const)
        for (const interrupted of [false, true])
          it.effect(
            `the later edit to X wins with ${first} first, interrupted=${interrupted}`,
            () =>
              Effect.gen(function* () {
                const world = yield* makeAuthorSyncWorld();
                yield* world.connect();
                yield* world.a.edit("x.txt", "base X\n");
                yield* world.a.edit("y.txt", "base Y\n");
                yield* world.a.sync();
                yield* world.b.sync();
                yield* world.c.sync();
                yield* TestClock.adjust("1 minute");
                yield* world.a.edit("x.txt", "A older X\n");
                yield* refreshWorkspace(world.a.workspace).pipe(
                  Effect.provide(authorLayer(world.a.home)),
                );
                yield* TestClock.adjust("1 minute");
                yield* world.b.edit("x.txt", "B later X\n");
                yield* refreshWorkspace(world.b.workspace).pipe(
                  Effect.provide(authorLayer(world.b.home)),
                );
                yield* TestClock.adjust("30 seconds");
                yield* world.c.edit("x.txt", "C latest X\n");
                yield* refreshWorkspace(world.c.workspace).pipe(
                  Effect.provide(authorLayer(world.c.home)),
                );
                yield* TestClock.adjust("30 seconds");
                yield* world.a.edit("y.txt", "A latest Y\n");
                yield* refreshWorkspace(world.a.workspace).pipe(
                  Effect.provide(authorLayer(world.a.home)),
                );
                yield* world.a.restart();
                yield* world.b.restart();
                const second = first === "a" ? "b" : "a";
                yield* world[first].sync();
                if (interrupted) {
                  const fs = yield* FileSystem.FileSystem;
                  const target = join(world[second].workspace, first === "a" ? "y.txt" : "x.txt");
                  let stopped = false;
                  const result = yield* Effect.exit(
                    world[second].sync().pipe(
                      Effect.provideService(FileSystem.FileSystem, {
                        ...fs,
                        link: Effect.fn(function* (from, to) {
                          yield* fs.link(from, to);
                          if (to === target && !stopped) {
                            stopped = true;
                            return yield* Effect.die("fixture exited after replacing a file");
                          }
                        }),
                      }),
                    ),
                  );
                  expect(stopped).toBe(true);
                  expect(result).toMatchObject({
                    _tag: "Failure",
                    cause: {
                      reasons: [
                        {
                          _tag: "Die",
                          defect: "fixture exited after replacing a file",
                        },
                      ],
                    },
                  });
                  yield* world[second].restart();
                }
                yield* world[second].sync();
                yield* world[first].sync();
                for (const device of [world.a, world.b]) {
                  expect(yield* device.read("x.txt")).toBe("B later X\n");
                  expect(yield* device.read("y.txt")).toBe("A latest Y\n");
                }
                // C's edit predates the merge/pull but follows B's edit. Sync's own
                // writes must not make B's older X appear newly authored.
                yield* TestClock.adjust("1 minute");
                yield* world.c.restart();
                yield* world.c.sync();
                yield* world.a.sync();
                yield* world.b.sync();
                for (const device of [world.a, world.b, world.c]) {
                  expect(yield* device.read("x.txt")).toBe("C latest X\n");
                  expect(yield* device.read("y.txt")).toBe("A latest Y\n");
                }
                expect(yield* world.missing(yield* world.copies())).toEqual([]);
              }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
          );
    });
    describe("Per-path times follow a skill rename during a conflicting edit.", () => {
      for (const first of ["a", "b"] as const)
        it.effect(`the later edit follows the renamed skill with ${first} syncing first`, () =>
          Effect.gen(function* () {
            const world = yield* makeAuthorSyncWorld();
            const fs = yield* FileSystem.FileSystem;
            const skill = (name: string, body: string) =>
              `---\nname: ${name}\ndescription: Release notes.\n---\n# Notes\n${body}\nKeep them short.\n`;
            yield* world.connect();
            yield* world.a.edit("extra/notes/SKILL.md", skill("notes", "base"));
            yield* world.a.sync();
            yield* world.b.sync();
            yield* TestClock.adjust("1 minute");
            yield* fs.rename(
              join(world.a.workspace, "extra/notes"),
              join(world.a.workspace, "extra/changelog"),
            );
            yield* world.a.edit("extra/changelog/SKILL.md", skill("changelog", "A older body"));
            yield* refreshWorkspace(world.a.workspace).pipe(
              Effect.provide(authorLayer(world.a.home)),
            );
            yield* TestClock.adjust("1 minute");
            yield* world.b.edit("extra/notes/SKILL.md", skill("notes", "B later body"));
            yield* refreshWorkspace(world.b.workspace).pipe(
              Effect.provide(authorLayer(world.b.home)),
            );
            const second = first === "a" ? "b" : "a";
            yield* world[first].sync(false, true);
            yield* world[second].sync(false, true);
            yield* world[first].sync(false, true);
            for (const device of [world.a, world.b])
              expect(yield* device.read("extra/changelog/SKILL.md")).toBe(
                skill("changelog", "B later body"),
              );
          }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
        );
    });
    describe("For overlapping edits, the version observed later wins.", () => {
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
              yield* refreshWorkspace(older.workspace).pipe(
                Effect.provide(authorLayer(older.home)),
              );
              yield* TestClock.adjust("1 minute");
              yield* edit(newer);
              yield* refreshWorkspace(newer.workspace).pipe(
                Effect.provide(authorLayer(newer.home)),
              );
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
              expect(yield* world.a.read(path)).toBe(
                winner === "file" ? "file side" : "directory side",
              );
              expect(yield* world.a.read("ours.txt")).toBe("independent ours");
              expect(yield* world.a.read("theirs.txt")).toBe("independent theirs");
              expect(
                (yield* world.a.files()).map(({ path, bytes }) => ({ path, bytes: [...bytes] })),
              ).toEqual(
                (yield* world.b.files()).map(({ path, bytes }) => ({ path, bytes: [...bytes] })),
              );
              expect(yield* world.missing(yield* world.copies())).toEqual([]);
              expect(
                (yield* world.server.revisions()).every(
                  ({ tree }) => History.treePathIssue(tree) === undefined,
                ),
              ).toBe(true);
            }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
          );
    });
  });
  describe("Recovering interrupted work", () => {
    describe("Sync can recover an interrupted replacement between a file and a folder.", () => {
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
              yield* world.b.remove("notes");
              const downloaded = direction === "file-to-directory" ? "notes/a.txt" : "notes";
              yield* world.b.edit(downloaded, "remote change", "remote");
              expect((yield* world.b.sync()).status).toBe("waiting_for_removal");
              expect((yield* world.b.sync(false, true)).status).toBe("pushed");
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
                          return yield* Effect.die(
                            "process stopped after removing the predecessor",
                          );
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
              if (direction === "directory-to-file") yield* world.a.remove("notes");
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
              ).toEqual(
                (yield* world.b.files()).map(({ path, bytes }) => ({ path, bytes: [...bytes] })),
              );
            }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
        );
    });
  });
});
