import { createHash } from "node:crypto";
import { Cause, Deferred, Effect, Fiber, FileSystem, Sink } from "effect";
import { systemError } from "effect/PlatformError";
import { Readable } from "node:stream";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { ZipFile } from "yazl";
import { createSkitArchiveEffect, skitLayer } from "../src/index.js";
import { copySkitFixtureEffect } from "./helpers/skit-fixture.js";

it.effect.each([
  "read-failure",
  "read-interrupt",
  "sink-failure",
  "sink-interrupt",
  "existing",
] as const)("archive finalizes its producer on %s and preserves output ownership", (stage) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-archive-lifetime-" });
    const outputRoot = yield* fs.makeTempDirectoryScoped({ prefix: "skit-archive-output-" });
    const output = join(outputRoot, "release.zip");
    yield* copySkitFixtureEffect("authored", root);
    if (stage === "existing") yield* fs.writeFileString(output, "pre-existing archive");
    let producer: Readable | undefined;
    const addBuffer = ZipFile.prototype.addBuffer;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(ZipFile.prototype, "addBuffer").mockImplementation(function (
          this: ZipFile,
          ...args
        ) {
          if (!(this.outputStream instanceof Readable))
            throw new Error("Expected Readable producer");
          producer = this.outputStream;
          return addBuffer.apply(this, args);
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    const ready = yield* Deferred.make<void>();
    const error = systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFile",
      pathOrDescriptor: root,
    });
    const pause = Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never));
    let packaging = false;
    let reads = 0;
    let sinkFinalized = false;
    const operation = Effect.gen(function* () {
      return yield* createSkitArchiveEffect(root, output).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          makeDirectory: (path, options) =>
            fs.makeDirectory(path, options).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  packaging = true;
                }),
              ),
            ),
          readFile: (path) => {
            if (packaging && ++reads === 2 && stage.startsWith("read"))
              return stage === "read-failure" ? Effect.fail(error) : pause;
            return fs.readFile(path);
          },
          sink: (path, options) =>
            fs.sink(path, options).pipe(
              Sink.mapInputEffect((bytes: Uint8Array) =>
                stage === "sink-failure"
                  ? Effect.fail(error)
                  : stage === "sink-interrupt"
                    ? pause
                    : Effect.succeed(bytes),
              ),
              Sink.ensuring(
                Effect.sync(() => {
                  sinkFinalized = true;
                }),
              ),
            ),
        }),
      );
    });
    const fiber = yield* Effect.forkChild(operation);
    if (stage.endsWith("interrupt")) {
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
    }
    const exit = yield* Fiber.await(fiber);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(stage.endsWith("interrupt"));
      expect(Cause.hasDies(exit.cause)).toBe(false);
    }
    expect(producer?.destroyed).toBe(true);
    expect(producer?.closed).toBe(true);
    if (stage.startsWith("read")) {
      expect(sinkFinalized).toBe(false);
      expect(yield* fs.exists(output)).toBe(false);
    } else {
      expect(sinkFinalized).toBe(true);
      expect(yield* fs.readFileString(output)).toBe(
        stage === "existing" ? "pre-existing archive" : "",
      );
    }
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("archives retain deterministic bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-archive-identity-" });
    const output = yield* fs.makeTempDirectoryScoped({ prefix: "skit-archive-identity-output-" });
    yield* copySkitFixtureEffect("authored", root);
    const archive = join(output, "release.zip");
    yield* createSkitArchiveEffect(root, archive);
    expect(
      createHash("sha256")
        .update(yield* fs.readFile(archive))
        .digest("hex"),
    ).toBe("f0e17ec3d839ef0280067459241c2fd2a0d73fc68221e5fde7e9376314aac60e");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
