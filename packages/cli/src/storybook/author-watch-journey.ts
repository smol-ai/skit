import { Cause, Deferred, Effect, Schema, Fiber, Layer, Ref, Schedule } from "effect";
import { skitLayer, skitConfigurationLayer } from "@smolai/skit-core/platform";
import { authorWorkspaceLayer, type AuthorWatchEvent } from "@smolai/skit-core/author";
import { makeAuthorSyncWorld } from "../platform/author-sync-fixture/world.js";
import { storedTreesAt } from "../platform/author-sync-fixture/history.js";
import { Renderer } from "../terminal/renderer.js";
import { result } from "../commands/result.js";
import type { TypeCommand } from "./interaction-recorder.js";
import type { ScenarioStory } from "./journey-stories.js";

type WatchWorld = Effect.Success<ReturnType<typeof makeAuthorSyncWorld>>;
const retry = { schedule: Schedule.spaced("100 millis"), times: 150 };

const runOffline = (registered: boolean, world: WatchWorld, typed: TypeCommand) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<readonly AuthorWatchEvent[]>([]);
    const renderer = yield* Renderer;
    const awaitEvent = (matches: (event: AuthorWatchEvent) => boolean) =>
      Effect.gen(function* () {
        const trace = yield* Ref.get(events);
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message: "Scenario assertion failed: " + JSON.stringify({ events: trace }),
          }),
        )(trace.some(matches));
      }).pipe(Effect.retry(retry));
    yield* typed("skit author watch");
    const watcher = yield* world.a.startWatch((event) =>
      renderer
        .result(result("authorWatch", event))
        .pipe(Effect.andThen(Ref.update(events, (trace) => [...trace, event]))),
    );
    yield* awaitEvent((event) => event.event === "retrying" && event.operation === "sync");
    const path = "skills/review/SKILL.md";
    const content =
      "---\nname: review\ndescription: Review code.\n---\n# Review\nCheck changed behavior and its evidence.\n";
    yield* world.a.edit(path, content, "remote");
    yield* awaitEvent((event) => event.event === "saved_locally" && event.paths.includes(path));
    // Observe two more production foreground intervals before checking suppression.
    yield* Effect.sleep("6500 millis");
    const offline = yield* Ref.get(events);
    yield* Schema.decodeUnknownEffect(
      Schema.Literal(true).annotate({
        message: "Scenario assertion failed: " + JSON.stringify({ events: offline }),
      }),
    )(
      offline.filter((event) => event.event === "retrying" && event.operation === "sync").length ===
        1,
    );
    if (registered) {
      const installed = yield* world.a.installed("review/SKILL.md");
      yield* Schema.decodeUnknownEffect(
        Schema.Literal(true).annotate({
          message:
            "Scenario assertion failed: " +
            JSON.stringify({
              installed,
              events: offline,
            }),
        }),
      )(installed.includes("Check changed behavior"));
    } else {
      yield* Schema.decodeUnknownEffect(
        Schema.Literal(true).annotate({
          message: "Scenario assertion failed: " + JSON.stringify({ events: offline }),
        }),
      )(
        offline.some(
          (event) =>
            event.event === "installation" &&
            event.status === "unregistered" &&
            event.installed === 0 &&
            event.installed_copies.length === 0,
        ),
      );
    }
    yield* world.server.setOnline("a", true);
    yield* awaitEvent((event) => event.event === "recovered" && event.operation === "sync");
    yield* Effect.sleep("3500 millis");
    const trace = yield* Ref.get(events);
    yield* Schema.decodeUnknownEffect(
      Schema.Literal(true).annotate({
        message: "Scenario assertion failed: " + JSON.stringify({ events: trace }),
      }),
    )(
      trace.filter((event) => event.event === "recovered" && event.operation === "sync").length ===
        1,
    );
    yield* Schema.decodeUnknownEffect(
      Schema.Literal(true).annotate({
        message: "Scenario assertion failed: " + JSON.stringify({ events: trace }),
      }),
    )(!trace.some((event) => event.event === "sync" && event.result.status === "up_to_date"));
    yield* world.a.restart();
    yield* Fiber.await(watcher);
    yield* world.b.sync();
    const actual = yield* world.b.read(path);
    yield* Schema.decodeUnknownEffect(
      Schema.Literal(true).annotate({
        message:
          "Scenario assertion failed: " + JSON.stringify({ path, actual, expected: content }),
      }),
    )(actual === content);
    const missing = yield* world.missing(yield* world.copies());
    yield* Schema.decodeUnknownEffect(
      Schema.Literal(true).annotate({
        message: "Scenario assertion failed: " + JSON.stringify({ missing }),
      }),
    )(missing.length === 0);
  });

const runAtomicSave = (world: WatchWorld, typed: TypeCommand) =>
  Effect.gen(function* () {
    const expectedInstalled = (yield* world.b.installed("review/SKILL.md")).replace(
      "# Review",
      "# Automatically synchronized",
    );
    const renderer = yield* Renderer;
    const eventsA = yield* Ref.make<readonly AuthorWatchEvent[]>([]);
    const eventsB = yield* Ref.make<readonly AuthorWatchEvent[]>([]);
    const readyA = yield* Deferred.make<void>();
    const readyB = yield* Deferred.make<void>();
    yield* typed("skit author watch");
    // Record only device a's terminal. Device b's trace remains available in failed checks.
    yield* world.a.startWatch((event) =>
      renderer
        .result(result("authorWatch", event))
        .pipe(
          Effect.andThen(Ref.update(eventsA, (trace) => [...trace, event])),
          Effect.andThen(
            event.event === "installation" ? Deferred.succeed(readyA, undefined) : Effect.void,
          ),
          Effect.asVoid,
        ),
    );
    yield* world.b.startWatch((event) =>
      Ref.update(eventsB, (trace) => [...trace, event]).pipe(
        Effect.andThen(
          event.event === "installation" ? Deferred.succeed(readyB, undefined) : Effect.void,
        ),
        Effect.asVoid,
      ),
    );
    // Initial workspace scan precedes installation; do not race the initial baseline capture.
    yield* Deferred.await(readyA);
    yield* Deferred.await(readyB);
    const path = "skills/review/SKILL.md";
    const content =
      "---\nname: review\ndescription: Review code.\n---\n# Automatically synchronized\n";
    yield* world.a.saveAtomically(path, content);
    yield* Effect.gen(function* () {
      const events = yield* Ref.get(eventsA);
      yield* Schema.decodeUnknownEffect(
        Schema.Literal(true).annotate({
          message: "Scenario assertion failed: " + JSON.stringify({ device: "a", events }),
        }),
      )(
        events.some(
          (event) =>
            event.event === "saved_locally" &&
            event.trigger === "filesystem" &&
            event.paths.includes(path),
        ),
      );
    }).pipe(Effect.retry(retry));
    yield* Effect.gen(function* () {
      const actual = yield* world.b.read(path);
      yield* Schema.decodeUnknownEffect(
        Schema.Literal(true).annotate({
          message:
            "Scenario assertion failed: " +
            JSON.stringify({
              actual,
              expected: content,
              eventsA: yield* Ref.get(eventsA),
              eventsB: yield* Ref.get(eventsB),
            }),
        }),
      )(actual === content);
    }).pipe(Effect.retry(retry));
    yield* Effect.gen(function* () {
      const actual = yield* world.a.installed("review/SKILL.md");
      yield* Schema.decodeUnknownEffect(
        Schema.Literal(true).annotate({
          message:
            "Scenario assertion failed: " +
            JSON.stringify({
              actual,
              expected: expectedInstalled,
              events: yield* Ref.get(eventsA),
            }),
        }),
      )(actual === expectedInstalled);
    }).pipe(Effect.retry(retry));
    yield* Effect.gen(function* () {
      const actual = yield* world.b.installed("review/SKILL.md");
      yield* Schema.decodeUnknownEffect(
        Schema.Literal(true).annotate({
          message:
            "Scenario assertion failed: " +
            JSON.stringify({
              actual,
              expected: expectedInstalled,
              events: yield* Ref.get(eventsB),
            }),
        }),
      )(actual === expectedInstalled);
    }).pipe(Effect.retry(retry));
    const revisions = yield* world.server.revisions();
    yield* Schema.decodeUnknownEffect(
      Schema.Literal(true).annotate({
        message: "Scenario assertion failed: " + JSON.stringify({ revisions }),
      }),
    )(
      revisions.some(({ tree }) =>
        tree.some(
          (entry) =>
            entry.kind === "file" &&
            entry.path === path &&
            Buffer.from(entry.bytes).toString() === content,
        ),
      ),
    );
  });

const runStalled = (world: WatchWorld, typed: TypeCommand) =>
  Effect.gen(function* () {
    const gate = yield* world.server.gate("a", "after-post");
    const ready = yield* Deferred.make<void>();
    const events = yield* Ref.make<readonly AuthorWatchEvent[]>([]);
    const renderer = yield* Renderer;
    yield* typed("skit author watch");
    const watcher = yield* world.a.startWatch((event) =>
      renderer
        .result(result("authorWatch", event))
        .pipe(
          Effect.andThen(Ref.update(events, (trace) => [...trace, event])),
          Effect.andThen(
            event.event === "watching" ? Deferred.succeed(ready, undefined) : Effect.void,
          ),
          Effect.asVoid,
        ),
    );
    yield* Deferred.await(ready);
    yield* world.a.edit("offline.txt", "first offline edit");
    yield* gate.reached();
    yield* world.a.edit("offline.txt", "second offline edit");
    yield* Effect.gen(function* () {
      const trees = yield* storedTreesAt(world.a.home);
      yield* Schema.decodeUnknownEffect(
        Schema.Literal(true).annotate({
          message:
            "Scenario assertion failed: " +
            JSON.stringify({ trees, events: yield* Ref.get(events) }),
        }),
      )(
        trees.some(({ tree }) =>
          tree.some(
            (entry) =>
              entry.kind === "file" &&
              entry.path === "offline.txt" &&
              Buffer.from(entry.bytes).toString() === "second offline edit",
          ),
        ),
      );
    }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 80 }));
    yield* world.a.restart();
    const stopped = yield* Fiber.await(watcher);
    yield* Schema.decodeUnknownEffect(
      Schema.Literal(true).annotate({
        message:
          "Scenario assertion failed: " +
          JSON.stringify({
            stopped,
            events: yield* Ref.get(events),
          }),
      }),
    )(stopped._tag === "Failure" && Cause.hasInterrupts(stopped.cause));
    yield* gate.release();
    const synced = yield* world.a.sync();
    yield* Schema.decodeUnknownEffect(
      Schema.Literal(true).annotate({
        message:
          "Scenario assertion failed: " +
          JSON.stringify({
            synced,
          }),
      }),
    )(["pushed", "merged", "up_to_date"].includes(synced.status));
  });

const platform = Layer.mergeAll(
  skitLayer,
  skitConfigurationLayer(),
  authorWorkspaceLayer.pipe(Layer.provide(skitLayer)),
);

const worldLabels = {
  registryOnline: "Registry is online",
  registerA: "Workspace registered on device a",
  registerB: "Workspace registered on device b",
};

export const authorWatchScenarioSet = {
  command: "author watch",
  worldLabels,
  scenarios: [
    ...[true, false].map((registered) => ({
      name: `author-watch/${registered ? "offline-install-and-recover" : "unregistered-recovery"}`,
      description: registered
        ? "Offline save, installation and recovery"
        : "Unregistered workspace recovery",
      world: {
        registryOnline: false,
        registerA: registered,
        registerB: false,
      },
      run: (world: WatchWorld, typed: TypeCommand) => runOffline(registered, world, typed),
    })),
    {
      name: "author-watch/atomic-save",
      description: "Native atomic save across two watching devices",
      world: { registryOnline: true, registerA: true, registerB: true },
      run: runAtomicSave,
    },
    {
      name: "author-watch/stalled-registry",
      description: "Local edits during a stalled Registry request",
      world: { registryOnline: true, registerA: false, registerB: false },
      run: runStalled,
    },
  ].map(
    (scenario) =>
      ({
        _tag: "Scenario",
        terminalDevice: "a",
        name: scenario.name,
        description: scenario.description,
        world: scenario.world,
        worldLabels: worldLabels satisfies Record<keyof typeof scenario.world, string>,
        answers: [],
        run: (root: string, typed: TypeCommand) =>
          Effect.gen(function* () {
            const world = yield* makeAuthorSyncWorld(root);
            yield* world.connect();
            if (scenario.world.registerA) yield* world.a.registerAndEnable();
            if (scenario.world.registerB) yield* world.b.registerAndEnable();
            yield* world.server.setOnline("a", scenario.world.registryOnline);
            yield* scenario.run(world, typed);
          }).pipe(Effect.scoped, Effect.provide(platform)),
      }) satisfies ScenarioStory<unknown, Renderer>,
  ),
};
