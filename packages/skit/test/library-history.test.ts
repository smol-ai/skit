import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { Library } from "../src/library/library.js";
import { libraryLayer } from "./helpers/library-store.js";
import { classifyLibraryAuditEvent } from "../src/library/audit/state-diff.js";
import { migratedMachineId } from "../src/library/entity-ids.js";
import { importCollection } from "../src/library/import-collection.js";
import {
  LibraryActor,
  LibraryStore,
  withLibraryWriter,
} from "../src/library/store/library-store.js";
import { libraryStoreLayer } from "../src/library/library-store-layer.js";
import { withHomeLock } from "../src/library/store/writer-lock.js";
import type { LibraryState } from "../src/library/library-state.js";
import { skitLayer } from "../src/platform/layer.js";

const machineId = migratedMachineId("019950c0-4c00-7000-8000-000000000001", "library-history-test");

it("names committed changes by their operation or dominant domain transition", () => {
  assert.strictEqual(
    classifyLibraryAuditEvent("sync", [{ entity: "skill", id: "skill", action: "added" }]),
    "library.synced",
  );
  assert.strictEqual(
    classifyLibraryAuditEvent("setup", [
      { entity: "collection", id: "collection", action: "added" },
      { entity: "binding", id: "binding", action: "enabled" },
    ]),
    "custody.adopted",
  );
  assert.strictEqual(
    classifyLibraryAuditEvent("setup", [
      { entity: "collection", id: "collection", action: "added" },
      { entity: "skill", id: "skill", action: "added" },
    ]),
    "collection.retained",
  );
  assert.strictEqual(
    classifyLibraryAuditEvent("tui", [{ entity: "binding", id: "binding", action: "disabled" }]),
    "binding.disabled",
  );
  assert.strictEqual(
    classifyLibraryAuditEvent("inventory", [
      { entity: "projection", id: "projection", action: "suppressed" },
    ]),
    "projection.native-deletion-observed",
  );
});

const library = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-library-history-" });
  const home = join(workspace, "home");
  const source = join(workspace, "source");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.writeFileString(join(source, "SKILL.md"), "raw Skill bytes\n");
  const inLibrary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(libraryStoreLayer({ home })));
  const importSource = importCollection({
    machineId,
    source: { type: "local", path: source },
    input: source,
    importedAt: "2026-09-17T00:00:00.000Z",
    skills: [
      {
        name: "review",
        sourcePath: source,
        relativePath: ".",
        currentHash: yield* deterministicTreeHash(source),
      },
    ],
    lockFileEntries: [],
  });
  const history = Effect.flatMap(Library.Service, (owner) =>
    Effect.map(owner.history, (history) => history.events),
  ).pipe(Effect.provide(libraryLayer(home)));
  return { inLibrary, importSource, history, home };
});

const globalEnabled = (state: LibraryState) =>
  state.skills.map((skill) => ({ skill: skill.skill_id }));

it.effect("records one event for one action, however many writers it nests", () =>
  Effect.gen(function* () {
    const { inLibrary, importSource, history } = yield* library;
    yield* inLibrary(
      withLibraryWriter(
        Effect.gen(function* () {
          yield* Effect.scoped(withLibraryWriter(importSource));
          const store = yield* LibraryStore;
          const state = yield* store.load;
          yield* withLibraryWriter(
            store.save(
              {
                ...state,
                enabled: state.skills.map((skill) => ({ skill: skill.skill_id })),
              },
              state,
            ),
          );
        }),
      ),
    ).pipe(Effect.provideService(LibraryActor, "test-front-end"));

    const events = yield* history;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]?.type, "collection.retained");
    assert.strictEqual(events[0]?.workflow, "test-front-end");
    assert.deepStrictEqual(
      events[0]?.changes.map((change) => `${change.entity}:${change.action}`),
      ["collection:added", "skill:added", "binding:enabled"],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("records nothing when a writer leaves the Library as it found it", () =>
  Effect.gen(function* () {
    const { inLibrary, history } = yield* library;
    yield* inLibrary(withLibraryWriter(Effect.flatMap(LibraryStore, (store) => store.load)));
    assert.deepStrictEqual(yield* history, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("records what was committed before a mutation failed", () =>
  Effect.gen(function* () {
    const { inLibrary, importSource, history } = yield* library;
    const outcome = yield* inLibrary(
      withLibraryWriter(
        Effect.scoped(importSource).pipe(
          Effect.andThen(Effect.fail("failed after committing" as const)),
        ),
      ),
    ).pipe(Effect.flip);
    assert.strictEqual(outcome, "failed after committing");
    const events = yield* history;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]?.type, "collection.retained");
    assert.strictEqual(events[0]?.workflow, "unattributed");
    assert.strictEqual(events[0]?.changes[0]?.action, "added");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("keeps a committed mutation successful when its history cannot be written", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { inLibrary, importSource, home } = yield* library;
    // A directory where the log should be makes every append fail.
    yield* fs.makeDirectory(join(home, "audit.jsonl"), { recursive: true });
    const imported = yield* inLibrary(withLibraryWriter(Effect.scoped(importSource)));
    const state = yield* inLibrary(Effect.flatMap(LibraryStore, (store) => store.load));
    assert.strictEqual(state.collections[0]?.collection_id, imported.collection?.collection_id);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.live("records a forked save under way at release in its action's event", () =>
  Effect.gen(function* () {
    const { inLibrary, importSource, history, home } = yield* library;
    yield* inLibrary(withLibraryWriter(Effect.scoped(importSource)));
    const before = (yield* history).length;
    const store = yield* inLibrary(Effect.service(LibraryStore));
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const forked = yield* Deferred.make<Fiber.Fiber<void, unknown>>();
    const action = yield* inLibrary(
      withLibraryWriter(
        Effect.gen(function* () {
          const state = yield* store.load;
          const bound = { ...state, enabled: globalEnabled(state) };
          yield* store.save(bound, state);
          // The forked save takes its lease now and finishes only after the action's program.
          const child = yield* withHomeLock(
            home,
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
              Effect.andThen(store.save({ ...bound, enabled: [] }, bound)),
            ),
          ).pipe(Effect.forkDetach);
          yield* Deferred.succeed(forked, child);
          yield* Deferred.await(entered);
        }),
      ),
    ).pipe(Effect.forkChild);
    const child = yield* Deferred.await(forked);
    yield* Deferred.await(entered);
    yield* Effect.sleep("20 millis");
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(child);
    yield* Fiber.join(action);

    const events = (yield* history).slice(before);
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(
      events[0]?.changes.map((change) => `${change.entity}:${change.action}`),
      ["binding:enabled", "binding:disabled"],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.live("records a writer that outlives its action as an action of its own", () =>
  Effect.gen(function* () {
    const { inLibrary, importSource, history } = yield* library;
    yield* inLibrary(withLibraryWriter(Effect.scoped(importSource)));
    const before = (yield* history).length;
    const store = yield* inLibrary(Effect.service(LibraryStore));
    const resume = yield* Deferred.make<void>();
    const late = yield* inLibrary(
      withLibraryWriter(
        Effect.gen(function* () {
          const state = yield* store.load;
          yield* store.save({ ...state, enabled: globalEnabled(state) }, state);
          return yield* Deferred.await(resume).pipe(
            Effect.andThen(
              withLibraryWriter(
                Effect.gen(function* () {
                  const bound = yield* store.load;
                  yield* store.save({ ...bound, enabled: [] }, bound);
                }),
              ),
            ),
            Effect.forkDetach,
          );
        }),
      ),
    );
    assert.strictEqual((yield* history).length, before + 1);
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(late);

    const events = (yield* history).slice(before);
    assert.deepStrictEqual(
      events.map((event) => event.changes.map((change) => `${change.entity}:${change.action}`)),
      [["binding:enabled"], ["binding:disabled"]],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("the Library owner reads empty history without creating its home", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-owner-history-" });
    const home = join(workspace, "absent");
    const history = yield* Effect.flatMap(Library.Service, (owner) => owner.history).pipe(
      Effect.provide(libraryLayer(home)),
    );
    assert.deepStrictEqual(history, { events: [], operations: [] });
    assert.isFalse(yield* fs.exists(home));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("owner history includes unfinished operations without resuming them", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-owner-history-" });
    const home = join(workspace, "home");
    yield* Effect.gen(function* () {
      const owner = yield* Library.Service;
      const result = yield* owner.setup([], { base: yield* owner.read });
      assert.strictEqual(result._tag, "Done");
      const done = yield* owner.history;
      assert.strictEqual(done.operations[0]?._tag, "Done");
      assert.strictEqual(done.events.length, 1);
      const statePath = join(home, "state.json");
      const saved = JSON.parse(yield* fs.readFileString(statePath));
      saved.operations[0]._tag = "Pending";
      delete saved.operations[0].after;
      const pendingBytes = JSON.stringify(saved);
      yield* fs.writeFileString(statePath, pendingBytes);
      const filesBefore = (yield* fs.readDirectory(home)).sort();
      const pending = yield* owner.history;
      assert.strictEqual(pending.operations[0]?._tag, "Pending");
      assert.deepStrictEqual(pending.events, done.events);
      assert.strictEqual(yield* fs.readFileString(statePath), pendingBytes);
      assert.deepStrictEqual((yield* fs.readDirectory(home)).sort(), filesBefore);
    }).pipe(Effect.provide(libraryLayer(home)));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("owner history preserves a malformed audit line's path and number", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-owner-history-invalid-" });
    const path = join(home, "audit.jsonl");
    yield* fs.writeFileString(path, "{}\n");
    const failure = yield* Effect.flatMap(Library.Service, (owner) => owner.history).pipe(
      Effect.provide(libraryLayer(home)),
      Effect.flip,
    );
    assert.isTrue(failure._tag === "LibraryAuditInvalid");
    if (failure._tag === "LibraryAuditInvalid") {
      assert.strictEqual(failure.path, path);
      assert.strictEqual(failure.line, 1);
    }
    assert.strictEqual(yield* fs.readFileString(path), "{}\n");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
