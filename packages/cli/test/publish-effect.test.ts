import { Cause, Deferred, Effect, Fiber, FileSystem, Sink } from "effect";
import { systemError } from "effect/PlatformError";
import { skitLayer } from "@smolai/skit-core";
import { join } from "node:path";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { fetchTestClientLayer } from "./helpers/http-test-client.js";
import { publishEffect } from "../src/workflows/author/publish.js";
import { copySkitFixtureEffect, scratch } from "./helpers/library-home.js";

/** A scoped authored Skit with a Registry binding, built on the platform FileSystem. */
const fixture = Effect.fn("test.publishFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* scratch("skit-publish-effect-");
  yield* copySkitFixtureEffect("authored", root);
  yield* fs.writeFileString(
    join(root, "skit.remote.json"),
    JSON.stringify({
      schema: "skit.remote.v1",
      origin: "https://registry.test",
      namespace: "test",
      skit: "tools",
    }),
  );
  return root;
});
const success = () =>
  Response.json(
    {
      release: {
        release_id: "rel_1",
        version: "1.0.0",
        archive_digest: `sha256:${"a".repeat(64)}`,
        download_path: "/api/skits/test/tools/releases/1.0.0/download",
      },
    },
    { status: 201 },
  );

// Every case waits for the actual stage and then awaits interruption and scope finalization.
it.effect.each([
  "archive-read",
  "archive-sink",
  "discovery",
  "legacy-discovery",
  "discovery-body",
  "upload",
  "success-body",
  "forbidden-body",
] as const)("publication interruption at %s finalizes without subsequent work", (stage) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fixture();
    // The fetch and stream doubles are plain callbacks, so they signal through an unsafe completion.
    const ready = Deferred.makeUnsafe<void>();
    const reached = () => Deferred.doneUnsafe(ready, Effect.void);
    let finalized = false;
    let temporary = "";
    const requests: string[] = [];
    const signals: AbortSignal[] = [];
    const pause = Effect.sync(reached).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(
        Effect.sync(() => {
          finalized = true;
        }),
      ),
    );
    const pending = (signal: AbortSignal) =>
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            finalized = true;
            reject(signal.reason);
          },
          { once: true },
        );
        reached();
      });
    const body = (signal: AbortSignal, status: number) =>
      new Response(
        new ReadableStream(
          {
            start(controller) {
              signal.addEventListener(
                "abort",
                () => {
                  finalized = true;
                  controller.error(signal.reason);
                },
                { once: true },
              );
              // Pull marks actual body consumption, not merely receipt of headers.
            },
            pull() {
              reached();
              return new Promise<void>(() => {});
            },
          },
          { highWaterMark: 0 },
        ),
        { status, headers: { "content-type": "application/json" } },
      );
    const fetcher: typeof fetch = async (input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing operation signal");
      signals.push(signal);
      requests.push(String(input));
      const discovery = String(input).includes(".well-known");
      if (
        stage === "discovery" ||
        (stage === "legacy-discovery" && String(input).endsWith("/skit")) ||
        (stage === "upload" && !discovery)
      )
        return pending(signal);
      if (discovery)
        return stage === "discovery-body" ? body(signal, 200) : new Response(null, { status: 404 });
      return body(signal, stage === "forbidden-body" ? 403 : 201);
    };
    const operation = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* publishEffect(root, "1.0.0", undefined).pipe(
        Effect.provide(registryHttpLayer(fetchTestClientLayer(fetcher))),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          makeTempDirectory: (options) =>
            fs.makeTempDirectory(options).pipe(
              Effect.tap((path) =>
                Effect.sync(() => {
                  temporary = path;
                }),
              ),
            ),
          readFile: (path) =>
            temporary && !path.startsWith(temporary) && stage === "archive-read"
              ? pause
              : fs.readFile(path),
          sink: (path, options) =>
            stage === "archive-sink" ? Sink.fromEffect(pause) : fs.sink(path, options),
        }),
      );
    }).pipe(Effect.provide(skitLayer));
    const fiber = yield* Effect.forkChild(operation);
    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* Deferred.await(ready);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(finalized).toBe(true);
        expect(temporary).not.toBe("");
        expect(yield* fs.exists(temporary)).toBe(false);
        expect(requests).toHaveLength(
          stage.startsWith("archive")
            ? 0
            : stage === "discovery" || stage === "discovery-body"
              ? 1
              : stage === "legacy-discovery"
                ? 2
                : 3,
        );
        expect(signals.every((signal) => signal.aborted)).toBe(true);
      }),
      Fiber.interrupt(fiber),
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect.each([
  "success",
  "rejection",
  "transport",
  "parser",
  "defect",
  "cleanup",
  "cleanup-rejection",
  "http-defect",
] as const)("publication owns temporary state on %s", (outcome) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fixture();
    let temporary = "";
    let requests = 0;
    const defect = new Error("injected filesystem defect");
    const cleanupError = systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "remove",
      pathOrDescriptor: root,
    });
    const exit = yield* Effect.gen(function* () {
      return yield* publishEffect(root, "1.0.0", undefined).pipe(
        Effect.provide(
          registryHttpLayer(
            fetchTestClientLayer(async (input) => {
              requests++;
              if (outcome === "http-defect") throw new ReferenceError("broken HTTP implementation");
              if (String(input).includes(".well-known"))
                throw new TypeError("ordinary discovery failure");
              if (outcome === "transport") throw new TypeError("upload failed");
              return outcome === "rejection" || outcome === "cleanup-rejection"
                ? Response.json({ error: "release_conflict" }, { status: 409 })
                : outcome === "parser"
                  ? Response.json({ release: {} }, { status: 201 })
                  : success();
            }),
          ),
        ),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          makeTempDirectory: (options) =>
            fs.makeTempDirectory(options).pipe(
              Effect.tap((path) =>
                Effect.sync(() => {
                  temporary = path;
                }),
              ),
            ),
          readFile: (path) =>
            temporary && outcome === "defect" ? Effect.die(defect) : fs.readFile(path),
          remove: (path, options) =>
            outcome.startsWith("cleanup") && path === temporary
              ? Effect.fail(cleanupError)
              : fs.remove(path, options),
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.exit);
    yield* Effect.ensuring(
      Effect.gen(function* () {
        expect(exit._tag).toBe(outcome === "success" ? "Success" : "Failure");
        if (exit._tag === "Failure") {
          expect(Cause.hasDies(exit.cause)).toBe(
            outcome === "defect" || outcome.startsWith("cleanup"),
          );
          expect(Cause.hasFails(exit.cause)).toBe(outcome !== "defect" && outcome !== "cleanup");
          if (outcome === "transport")
            expect(Cause.squash(exit.cause)).toMatchObject({
              _tag: "RegistryTransportError",
              cause: { name: "Error" },
            });
          if (outcome === "http-defect")
            expect(Cause.squash(exit.cause)).toMatchObject({
              _tag: "RegistryTransportError",
              cause: { name: "Error" },
            });
          if (outcome === "parser")
            expect(Cause.squash(exit.cause)).toMatchObject({ name: "SkitContractError" });
          if (outcome === "rejection")
            expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "RegistryRejectedWrite" });
        }
        expect(requests).toBe(outcome === "defect" ? 0 : 2);
        if (outcome.startsWith("cleanup"))
          expect(yield* fs.readDirectory(temporary)).toEqual(["release.zip"]);
        else expect(yield* fs.exists(temporary)).toBe(false);
      }),
      fs.remove(temporary, { recursive: true, force: true }).pipe(Effect.orDie),
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
