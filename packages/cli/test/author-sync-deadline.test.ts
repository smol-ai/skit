import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as History from "@smolai/skit-core/history";
import { makeMachineId } from "@smolai/skit-core/universal/consumer";
import { authorSyncApi } from "../src/registry/author-sync.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { testHttpClientLayer } from "./helpers/http-test-client.js";
import { makeAuthorSyncWorld } from "./helpers/author-sync-world.js";
import { testPlatformLayer } from "./helpers/platform.js";

const remote = {
  schema: "skit.remote.v1" as const,
  origin: "https://registry.example",
  namespace: "swyx",
  skit: "tools",
};

for (const stage of ["headers", "body"] as const)
  it.effect.each([
    "current",
    "revision",
    "ancestors",
    "post",
    "move",
    "available",
    "create",
  ] as const)(`bounds %s through stalled ${stage} without retrying`, (operation) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      let requests = 0;
      let cancelled = false;
      const transport = testHttpClientLayer((_request, _url, signal) => {
        requests++;
        if (stage === "headers")
          return Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                cancelled = true;
              }),
            ),
          );
        return Effect.succeed(
          new Response(
            new ReadableStream(
              {
                pull(controller) {
                  signal.addEventListener(
                    "abort",
                    () => {
                      cancelled = true;
                      controller.error(signal.reason);
                    },
                    { once: true },
                  );
                  Deferred.doneUnsafe(ready, Effect.void);
                },
              },
              { highWaterMark: 0 },
            ),
            {
              status: operation === "create" ? 201 : 200,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      });
      const revision: History.Revision = {
        tree: yield* History.treeHash([]),
        parents: [],
        author: { device: makeMachineId(), at: 0 },
      };
      const id = yield* History.revisionId(revision);
      const run = Effect.gen(function* () {
        const api = yield* authorSyncApi({ remote, locator: "skit://registry.example/swyx/tools" });
        switch (operation) {
          case "current":
            return yield* api.remote.current;
          case "revision":
            return yield* api.remote.revision(id);
          case "ancestors":
            return yield* Stream.runDrain(api.remote.ancestors(id));
          case "post":
            return yield* api.remote.post(id, revision, []);
          case "move":
            return yield* api.remote.move(null, id);
          case "available":
            return yield* api.requireAvailable;
          case "create":
            return yield* api.create("private", "deadline-test");
        }
      }).pipe(Effect.provide(registryHttpLayer(transport)), Effect.scoped, Effect.result);
      const fiber = yield* Effect.forkChild(run);
      yield* Deferred.await(ready);
      yield* TestClock.adjust("29 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "RegistryUnreachable", origin: remote.origin },
      });
      expect(requests).toBe(1);
      expect(cancelled).toBe(true);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );

for (const connection of ["first", "connected"] as const)
  it.effect.each(
    connection === "first"
      ? ([
          "before-create",
          "after-create",
          "before-post",
          "after-post",
          "before-move",
          "after-move",
        ] as const)
      : (["before-current", "before-post", "after-post", "before-move", "after-move"] as const),
  )(`releases the workspace and recovers a timed-out ${connection} sync at %s`, (boundary) =>
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld();
      if (connection === "connected") {
        yield* world.connect();
        yield* world.a.edit("notes.txt", "offline authored edit", "remote");
      }
      const previousEvents = (yield* world.server.events()).length;
      const gate = yield* world.server.gate("a", boundary);
      const sync = yield* world.a.startSync(connection === "first");
      yield* gate.reached();
      yield* TestClock.adjust("30 seconds");
      expect(yield* Effect.result(Fiber.join(sync))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "RegistryUnreachable" },
      });
      const before = yield* world.a.files();
      const events = (yield* world.server.events()).slice(previousEvents);
      expect(events.filter((event) => event === `a:${boundary}`)).toHaveLength(1);
      // A new pass must acquire the same workspace lease, recover an ambiguous acknowledgement,
      // and finish without another destination prompt or duplicate revision.
      yield* world.a.sync();
      expect(yield* world.a.files()).toEqual(before);
      expect(yield* world.server.currentHistory()).toHaveLength(connection === "first" ? 1 : 2);
      expect((yield* world.a.sync()).status).toBe("up_to_date");
      expect(yield* world.missing(yield* world.copies())).toEqual([]);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );
