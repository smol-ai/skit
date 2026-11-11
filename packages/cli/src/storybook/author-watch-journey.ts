import { Cause, Deferred, Effect, Fiber, Layer, Ref, Schedule } from "effect";
import { skitLayer, skitConfigurationLayer } from "@smolai/skit-core/platform";
import { authorWorkspaceLayer, type AuthorWatchEvent } from "@smolai/skit-core/author";
import { makeAuthorSyncWorld } from "../platform/author-sync-fixture/world.js";
import { storedTreesAt } from "../platform/author-sync-fixture/history.js";
import { Renderer } from "../terminal/renderer.js";
import { result } from "../commands/result.js";
import type { TypeCommand } from "./interaction-recorder.js";
import type { ScenarioStory } from "./journey-stories.js";
import type { CheckRule } from "./rules.js";

// Rules without a successful check in a scenario remain unproven in Atlas.
const rules = {
  offline: "A Registry failure is reported as a sync retry",
  saved: "An offline authored edit is saved locally",
  once: "An unchanged sync failure is reported once",
  installed: "An offline authored edit reaches its installed copy",
  unregistered: "An unregistered workspace reports no installed copies",
  recovered: "Sync recovery is reported after the Registry returns",
  recoveredOnce: "An unchanged sync recovery is reported once",
  delivered: "The offline authored edit reaches the other device",
  conserved: "The offline authored edit remains recoverable",
  silent: "Idle sync stays silent",
  native: "Native filesystem events deliver an atomic save",
  converged: "Two watching devices converge after an atomic save without manual sync",
  copyA: "An atomic save reaches device a's installed copy",
  copyB: "An atomic save reaches device b's installed copy",
  remote: "The Registry keeps the atomic save",
  stalled: "Local history saves a newer edit while a Registry request is stalled",
  stopped: "Stopping watch interrupts its in-flight sync",
  restarted: "A new sync can complete after watch stops",
  invalid: "Invalid authored Skills hold installation",
  pending: "Pending removals hold installation",
  held: "A held installation keeps the installed instructions",
  configuration: "Installation reports configuration changes",
  issues: "Installation reports changed issues even when installed copies are unchanged",
  removal: "Watch confirms a stable removal across passes",
  nonblocking: "A pending removal does not block foreground sync",
  observeFailure: "An workspace scan failure is reported",
  observeOnce: "An unchanged workspace scan failure is reported once",
  observeRecovery: "Workspace scan recovery is reported after a failure",
  installFailure: "An installation failure is reported",
  installOnce: "An unchanged installation failure is reported once",
  installRecovery: "Installation recovery is reported after a failure",
  eventsFailure: "A native event stream failure is reported",
  eventsOnce: "An unchanged native event stream failure is reported once",
  eventsRecovery: "Native event recovery is reported after a failure",
  root: "Watch refuses a replaced root",
  identity: "Watch refuses a changed workspace identity",
  rescan: "Rescans save edits while native events fail",
  eventsRestart: "Native watching restarts after a stream failure",
  connected: "Watch refuses startup without a connected remote",
  identified: "Watch refuses startup without a workspace identity",
};

type WatchWorld = Effect.Success<ReturnType<typeof makeAuthorSyncWorld>>;
const retry = { schedule: Schedule.spaced("100 millis"), times: 150 };

const runOffline = (registered: boolean, world: WatchWorld, typed: TypeCommand, check: CheckRule) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<readonly AuthorWatchEvent[]>([]);
    const renderer = yield* Renderer;
    const awaitEvent = (rule: string, matches: (event: AuthorWatchEvent) => boolean) =>
      Effect.gen(function* () {
        const trace = yield* Ref.get(events);
        yield* check(rule, trace.some(matches), { events: trace });
      }).pipe(Effect.retry(retry));
    yield* typed("skit author watch");
    const watcher = yield* world.a.startWatch((event) =>
      renderer
        .result(result("authorWatch", event))
        .pipe(Effect.andThen(Ref.update(events, (trace) => [...trace, event]))),
    );
    yield* awaitEvent(
      rules.offline,
      (event) => event.event === "retrying" && event.operation === "sync",
    );
    const path = "skills/review/SKILL.md";
    const content =
      "---\nname: review\ndescription: Review code.\n---\n# Review\nCheck changed behavior and its evidence.\n";
    yield* world.a.edit(path, content, "remote");
    yield* awaitEvent(
      rules.saved,
      (event) => event.event === "saved_locally" && event.paths.includes(path),
    );
    // Observe two more production foreground intervals before checking suppression.
    yield* Effect.sleep("6500 millis");
    const offline = yield* Ref.get(events);
    yield* check(
      rules.once,
      offline.filter((event) => event.event === "retrying" && event.operation === "sync").length ===
        1,
      { events: offline },
    );
    if (registered) {
      const installed = yield* world.a.installed("review/SKILL.md");
      yield* check(rules.installed, installed.includes("Check changed behavior"), {
        installed,
        events: offline,
      });
    } else {
      yield* check(
        rules.unregistered,
        offline.some(
          (event) =>
            event.event === "installation" &&
            event.status === "unregistered" &&
            event.installed === 0 &&
            event.installed_copies.length === 0,
        ),
        { events: offline },
      );
    }
    yield* world.server.setOnline("a", true);
    yield* awaitEvent(
      rules.recovered,
      (event) => event.event === "recovered" && event.operation === "sync",
    );
    yield* Effect.sleep("3500 millis");
    const trace = yield* Ref.get(events);
    yield* check(
      rules.recoveredOnce,
      trace.filter((event) => event.event === "recovered" && event.operation === "sync").length ===
        1,
      { events: trace },
    );
    yield* check(
      rules.silent,
      !trace.some((event) => event.event === "sync" && event.result.status === "up_to_date"),
      { events: trace },
    );
    yield* world.a.restart();
    yield* Fiber.await(watcher);
    yield* world.b.sync();
    const actual = yield* world.b.read(path);
    yield* check(rules.delivered, actual === content, { path, actual, expected: content });
    const missing = yield* world.missing(yield* world.copies());
    yield* check(rules.conserved, missing.length === 0, { missing });
  });

const runAtomicSave = (world: WatchWorld, typed: TypeCommand, check: CheckRule) =>
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
      yield* check(
        rules.native,
        events.some(
          (event) =>
            event.event === "saved_locally" &&
            event.trigger === "filesystem" &&
            event.paths.includes(path),
        ),
        { device: "a", events },
      );
    }).pipe(Effect.retry(retry));
    yield* Effect.gen(function* () {
      const actual = yield* world.b.read(path);
      yield* check(rules.converged, actual === content, {
        actual,
        expected: content,
        eventsA: yield* Ref.get(eventsA),
        eventsB: yield* Ref.get(eventsB),
      });
    }).pipe(Effect.retry(retry));
    yield* Effect.gen(function* () {
      const actual = yield* world.a.installed("review/SKILL.md");
      yield* check(rules.copyA, actual === expectedInstalled, {
        actual,
        expected: expectedInstalled,
        events: yield* Ref.get(eventsA),
      });
    }).pipe(Effect.retry(retry));
    yield* Effect.gen(function* () {
      const actual = yield* world.b.installed("review/SKILL.md");
      yield* check(rules.copyB, actual === expectedInstalled, {
        actual,
        expected: expectedInstalled,
        events: yield* Ref.get(eventsB),
      });
    }).pipe(Effect.retry(retry));
    const revisions = yield* world.server.revisions();
    yield* check(
      rules.remote,
      revisions.some(({ tree }) =>
        tree.some(
          (entry) =>
            entry.kind === "file" &&
            entry.path === path &&
            Buffer.from(entry.bytes).toString() === content,
        ),
      ),
      { revisions },
    );
  });

const runStalled = (world: WatchWorld, typed: TypeCommand, check: CheckRule) =>
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
      yield* check(
        rules.stalled,
        trees.some(({ tree }) =>
          tree.some(
            (entry) =>
              entry.kind === "file" &&
              entry.path === "offline.txt" &&
              Buffer.from(entry.bytes).toString() === "second offline edit",
          ),
        ),
        { trees, events: yield* Ref.get(events) },
      );
    }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 80 }));
    yield* world.a.restart();
    const stopped = yield* Fiber.await(watcher);
    yield* check(rules.stopped, stopped._tag === "Failure" && Cause.hasInterrupts(stopped.cause), {
      stopped,
      events: yield* Ref.get(events),
    });
    yield* gate.release();
    const synced = yield* world.a.sync();
    yield* check(rules.restarted, ["pushed", "merged", "up_to_date"].includes(synced.status), {
      synced,
    });
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
  rules: Object.values(rules),
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
      run: (world: WatchWorld, typed: TypeCommand, check: CheckRule) =>
        runOffline(registered, world, typed, check),
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
        run: (root: string, typed: TypeCommand, check: CheckRule) =>
          Effect.gen(function* () {
            const world = yield* makeAuthorSyncWorld(root);
            yield* world.connect();
            if (scenario.world.registerA) yield* world.a.registerAndEnable();
            if (scenario.world.registerB) yield* world.b.registerAndEnable();
            yield* world.server.setOnline("a", scenario.world.registryOnline);
            yield* scenario.run(world, typed, check);
          }).pipe(Effect.scoped, Effect.provide(platform)),
      }) satisfies ScenarioStory<unknown, Renderer>,
  ),
};
