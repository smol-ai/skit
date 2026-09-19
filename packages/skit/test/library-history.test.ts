import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { deterministicTreeHashEffect } from "../src/artifact/skit.js";
import { LibraryAuditLog, libraryAuditLogLayer } from "../src/library/audit/audit-log.js";
import { classifyLibraryAuditEvent } from "../src/library/audit/state-diff.js";
import { migratedMachineId } from "../src/library/entity-ids.js";
import { retainObservedCollectionEffect } from "../src/library/portable-observed-import.js";
import {
  LibraryActor,
  LibraryStore,
  libraryStoreLayer,
  withLibraryWriter,
} from "../src/library/store/library-store.js";
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
  const retain = retainObservedCollectionEffect({
    machineId,
    identity: { profile: "local-collection", version: 1, path: source },
    input: source,
    retainedAt: "2026-09-17T00:00:00.000Z",
    skills: [
      {
        name: "review",
        sourcePath: source,
        relativePath: ".",
        observedHash: yield* deterministicTreeHashEffect(source),
      },
    ],
    observations: [],
  });
  const history = Effect.flatMap(LibraryAuditLog, (log) => log.list()).pipe(
    Effect.provide(libraryAuditLogLayer({ home })),
  );
  return { inLibrary, retain, history, home };
});

it.effect("records one event for one action, however many writers it nests", () =>
  Effect.gen(function* () {
    const { inLibrary, retain, history } = yield* library;
    yield* inLibrary(
      withLibraryWriter(
        Effect.gen(function* () {
          yield* Effect.scoped(withLibraryWriter(retain));
          const store = yield* LibraryStore;
          const state = yield* store.load;
          yield* withLibraryWriter(
            store.publish({
              ...state,
              global_bindings: [
                {
                  harness: "codex",
                  scope: { kind: "global" },
                  skills: state.skills.map((skill) => skill.skill_id),
                },
              ],
            }),
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
    const { inLibrary, retain, history } = yield* library;
    const outcome = yield* inLibrary(
      withLibraryWriter(
        Effect.scoped(retain).pipe(Effect.andThen(Effect.fail("failed after committing" as const))),
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
    const { inLibrary, retain, home } = yield* library;
    // A directory where the log should be makes every append fail.
    yield* fs.makeDirectory(join(home, "audit.jsonl"), { recursive: true });
    const retained = yield* inLibrary(withLibraryWriter(Effect.scoped(retain)));
    const state = yield* inLibrary(Effect.flatMap(LibraryStore, (store) => store.load));
    assert.strictEqual(state.collections[0]?.collection_id, retained.collection?.collection_id);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
