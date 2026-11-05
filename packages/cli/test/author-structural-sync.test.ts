import { expect, it } from "@effect/vitest";
import { Cause, Effect, FileSystem } from "effect";
import { systemError } from "effect/PlatformError";
import { join } from "node:path";
import { LinkStat } from "@smolai/skit-core";
import { makeAuthorSyncWorld } from "./helpers/author-sync-world.js";
import { testPlatformLayer } from "./helpers/platform.js";

for (const direction of ["file-to-directory", "directory-to-file"] as const)
  for (const boundary of [
    "complete",
    "staged",
    "removed",
    "directory-removed",
    "published",
    "checkpoint",
    "edited",
    "EXDEV",
  ] as const) {
    if (direction === "file-to-directory" && boundary === "directory-removed") continue;
    it.effect(`${direction} pull recovers after ${boundary}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const links = yield* LinkStat;
        const world = yield* makeAuthorSyncWorld();
        const before =
          direction === "file-to-directory"
            ? { notes: "old file" }
            : { "notes/a.txt": "old child", "notes/deep/b.txt": "old nested" };
        const after =
          direction === "file-to-directory"
            ? { "notes/a.txt": "new child", "notes/deep/b.txt": "new nested" }
            : { notes: "new file" };
        for (const [path, bytes] of Object.entries(before))
          yield* world.a.edit(path, bytes, "remote");
        yield* world.connect();
        yield* fs.remove(join(world.b.workspace, "notes"), { recursive: true });
        for (const [path, bytes] of Object.entries(after))
          yield* world.b.edit(path, bytes, "remote");
        yield* world.b.sync();
        let interrupted = false;
        let published = false;
        const stop = (at: typeof boundary) =>
          Effect.gen(function* () {
            if (
              (boundary === "edited" ? at !== "removed" : boundary !== at) ||
              interrupted ||
              boundary === "complete"
            )
              return;
            interrupted = true;
            return yield* Effect.die(`process exited after ${at}`);
          });
        const inWorkspace = (path: string) => path.startsWith(join(world.a.workspace, "notes"));
        const result = yield* Effect.exit(
          world.a.sync().pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              remove: (path, options) =>
                Effect.gen(function* () {
                  if (inWorkspace(path)) yield* stop("staged");
                  yield* fs.remove(path, options);
                  if (inWorkspace(path)) yield* stop("removed");
                }),
              link: (from, to) =>
                Effect.gen(function* () {
                  if (boundary === "EXDEV" && inWorkspace(to) && !interrupted) {
                    interrupted = true;
                    return yield* Effect.fail(
                      systemError({
                        _tag: "Unknown",
                        module: "FileSystem",
                        method: "link",
                        pathOrDescriptor: to,
                        cause: { code: "EXDEV" },
                      }),
                    );
                  }
                  yield* fs.link(from, to);
                  if (inWorkspace(to)) {
                    published = true;
                    yield* stop("published");
                  }
                }),
              rename: (from, to) =>
                Effect.gen(function* () {
                  if (published && to === join(world.a.home, "sync-bindings.json"))
                    yield* stop("checkpoint");
                  yield* fs.rename(from, to);
                }),
            }),
            Effect.provideService(LinkStat, {
              ...links,
              removeEmptyDirectory: (path) =>
                Effect.gen(function* () {
                  const removed = yield* links.removeEmptyDirectory(path);
                  if (removed && path === join(world.a.workspace, "notes"))
                    yield* stop("directory-removed");
                  return removed;
                }),
            }),
          ),
        );
        expect(
          result._tag,
          result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
        ).toBe(boundary === "complete" ? "Success" : "Failure");
        expect(interrupted).toBe(boundary !== "complete");
        yield* world.a.restart();
        if (boundary === "edited")
          yield* world.a.edit("unrelated.txt", "editor saved while interrupted", "remote");
        for (let attempt = 0; attempt < 2; attempt++) {
          yield* world.a.sync();
          yield* world.b.sync();
          for (const [path, bytes] of Object.entries(after))
            expect(yield* world.a.read(path)).toBe(bytes);
          expect(
            (yield* world.a.files()).map(({ path, bytes }) => ({ path, bytes: [...bytes] })),
          ).toEqual(
            (yield* world.b.files()).map(({ path, bytes }) => ({ path, bytes: [...bytes] })),
          );
        }
        if (boundary === "edited")
          expect(yield* world.a.read("unrelated.txt")).toBe("editor saved while interrupted");
        expect(yield* world.missing(yield* world.copies())).toEqual([]);
      }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
    );
  }
