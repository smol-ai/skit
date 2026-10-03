import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import { skitLayer, type LibraryState } from "@smolai/skit-core";
import { LibraryApiUnreachable } from "../src/workflows/library/library-sync-api.js";
import { devices } from "./helpers/library-sync-devices.js";

it.effect("each sync publishes state with the revision it reconciled against", () =>
  Effect.gen(function* () {
    const { a, b, remote } = yield* devices;
    const anchoredAt = (state: typeof a.state) =>
      Effect.gen(function* () {
        const head = yield* remote;
        const ancestry = (yield* state).sync_ancestry;
        assert.strictEqual(ancestry?.revision_id, head?.revision_id);
        assert.strictEqual(ancestry?.library_id, head?.library_id);
      });
    yield* a.retain("first");
    assert.strictEqual((yield* a.sync()).status, "pushed");
    yield* anchoredAt(a.state);
    assert.strictEqual((yield* b.sync()).status, "pulled");
    yield* anchoredAt(b.state);
    yield* b.retain("second");
    assert.strictEqual((yield* b.sync()).status, "merged");
    yield* anchoredAt(b.state);
    assert.strictEqual((yield* a.sync()).status, "merged");
    yield* anchoredAt(a.state);
    assert.strictEqual((yield* b.sync()).status, "clean");
    yield* anchoredAt(b.state);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

/**
 * Restoring an older `state.json`, from a backup or after a write lost to power failure, restores
 * the ancestry it was reconciled with. The next sync must not read the Collections the remote
 * gained since as local deletions and remove them from every device.
 */
it.effect("an older state.json does not delete Collections the remote gained since", () =>
  Effect.gen(function* () {
    const { fs, a, b, remoteCollections } = yield* devices;
    yield* a.retain("first");
    yield* a.sync();
    yield* b.sync();
    yield* b.retain("second");
    yield* b.sync();
    const added = yield* remoteCollections;
    assert.strictEqual(added.length, 2);

    const stateBeforeMerge = yield* fs.readFileString(join(a.home, "state.json"));
    assert.strictEqual((yield* a.sync()).status, "merged");
    yield* fs.writeFileString(join(a.home, "state.json"), stateBeforeMerge);

    yield* a.sync();
    assert.deepStrictEqual(yield* remoteCollections, added);
    assert.strictEqual((yield* a.state).collections.length, 2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a local removal after sync still removes the Collection everywhere", () =>
  Effect.gen(function* () {
    const { a, b, remoteCollections } = yield* devices;
    yield* a.retain("first");
    const removed = (yield* a.state).collections[0];
    assert.ok(removed);
    yield* a.retain("second");
    yield* a.sync();
    yield* b.sync();

    yield* a.remove(removed.collection_id);
    assert.ok((yield* a.state).sync_ancestry, "ordinary mutations keep sync ancestry");
    assert.strictEqual((yield* a.sync()).status, "merged");
    assert.notInclude(yield* remoteCollections, removed.collection_id);
    assert.strictEqual((yield* b.sync()).status, "merged");
    assert.isFalse(
      (yield* b.state).collections.some((item) => item.collection_id === removed.collection_id),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a write committed without a response leaves coherent state and converges", () =>
  Effect.gen(function* () {
    const { fs, a, b, inject, remoteCollections } = yield* devices;
    yield* a.retain("first");
    yield* a.sync();
    yield* b.sync();
    yield* a.retain("second");
    const stateBefore = yield* fs.readFileString(join(a.home, "state.json"));

    inject({ _tag: "DropAfterCommit" });
    assert.ok(Schema.is(LibraryApiUnreachable)(yield* Effect.flip(a.sync())));
    assert.strictEqual(yield* fs.readFileString(join(a.home, "state.json")), stateBefore);
    const committed = yield* remoteCollections;
    assert.strictEqual(committed.length, 2);

    // The remote already holds A's state, so the retry only re-anchors it.
    assert.strictEqual((yield* a.sync()).status, "clean");
    assert.deepStrictEqual(yield* remoteCollections, committed);
    assert.strictEqual((yield* b.sync()).status, "merged");
    assert.strictEqual((yield* b.state).collections.length, 2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("state without ancestry adopts explicitly and keeps remote-only Collections", () =>
  Effect.gen(function* () {
    const { a, b, remoteCollections } = yield* devices;
    yield* a.retain("first");
    yield* a.sync();
    // B has never synced, as a home upgraded from the sidecar-based ancestry has not either.
    yield* b.retain("second");
    const remoteOnly = yield* remoteCollections;

    assert.strictEqual((yield* b.sync()).status, "adoption_required");
    assert.strictEqual((yield* b.sync({ adopt: true })).status, "merged");
    const adopted = yield* remoteCollections;
    assert.strictEqual(adopted.length, 2);
    for (const collectionId of remoteOnly) assert.include(adopted, collectionId);
    assert.strictEqual((yield* a.sync()).status, "merged");
    assert.strictEqual((yield* a.state).collections.length, 2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

/** Enable one Skill globally with a device-local invocation policy. */
const enable =
  (skillId: string) =>
  (state: LibraryState): LibraryState => ({
    ...state,
    global_bindings: [
      {
        scope: { kind: "global" },
        entries: [
          ...(state.global_bindings[0]?.entries ?? []),
          { kind: "skill", skill_id: skillId as LibraryState["skills"][number]["skill_id"] },
        ],
        invocation_policies: {
          ...state.global_bindings[0]?.invocation_policies,
          [skillId]: "explicit",
        },
      },
    ],
  });

it.effect("a merge keeps device-local invocation policies", () =>
  Effect.gen(function* () {
    const { a, b } = yield* devices;
    yield* a.retain("first");
    const skillId = (yield* a.state).skills[0]!.skill_id;
    yield* a.edit(enable(skillId));
    yield* a.sync();
    yield* b.sync();
    yield* b.retain("second");
    yield* b.sync();

    assert.strictEqual((yield* a.sync()).status, "merged");
    const merged = yield* a.state;
    assert.strictEqual(merged.collections.length, 2);
    assert.deepStrictEqual(merged.global_bindings[0]?.invocation_policies, {
      [skillId]: "explicit",
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a projection failure after sync publishes leaves state and ancestry coherent", () =>
  Effect.gen(function* () {
    const { fs, a, b, remote } = yield* devices;
    yield* a.retain("first");
    yield* a.edit(enable((yield* a.state).skills[0]!.skill_id));
    yield* a.sync();
    // B's Harness root is occupied by a file, so no Projection can be written there.
    yield* fs.writeFileString(b.root, "not a directory\n");

    yield* Effect.exit(b.sync());
    const pulled = yield* b.state;
    assert.strictEqual(pulled.collections.length, 1);
    assert.strictEqual(pulled.sync_ancestry?.revision_id, (yield* remote)?.revision_id);

    yield* fs.remove(b.root);
    assert.strictEqual((yield* b.sync()).status, "clean");
    assert.isTrue(yield* fs.exists(join(b.root, "first", "SKILL.md")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a retry after a lost response conflicts with a later edit instead of overwriting it",
  () =>
    Effect.gen(function* () {
      const { a, c, inject, remote } = yield* devices;
      yield* a.retain("first");
      yield* a.sync();
      yield* c.sync();
      const relabel =
        (label: string) =>
        (state: LibraryState): LibraryState => ({
          ...state,
          collections: state.collections.map((item) => ({ ...item, label })),
        });

      yield* a.edit(relabel("from-a"));
      inject({ _tag: "DropAfterCommit" });
      assert.ok(Schema.is(LibraryApiUnreachable)(yield* Effect.flip(a.sync())));
      // C saw A's committed label and deliberately replaced it.
      assert.strictEqual((yield* c.sync()).status, "merged");
      yield* c.edit(relabel("from-c"));
      assert.strictEqual((yield* c.sync()).status, "merged");

      const retried = yield* a.sync();
      assert.strictEqual(retried.status, "conflicted");
      assert.strictEqual((yield* remote)?.manifest.collections[0]?.label, "from-c");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const removalSyncsFirst of [true, false])
  it.effect(
    `a removal wins over enabling its Skill elsewhere (removal syncs first=${removalSyncsFirst})`,
    () =>
      Effect.gen(function* () {
        const { a, b, remote } = yield* devices;
        yield* a.retain("first");
        yield* a.retain("second");
        yield* a.sync();
        yield* b.sync();
        const removed = (yield* a.state).collections[0]!.collection_id;
        const skillId = (yield* b.state).skills.find(
          (skill) => skill.collection_id === removed,
        )!.skill_id;

        yield* a.remove(removed);
        yield* b.edit(enable(skillId));
        const [first, second] = removalSyncsFirst ? [a, b] : [b, a];
        assert.strictEqual((yield* first.sync()).status, "merged");
        assert.strictEqual((yield* second.sync()).status, "merged");
        yield* first.sync();

        for (const device of [a, b]) {
          const state = yield* device.state;
          assert.isFalse(state.collections.some((item) => item.collection_id === removed));
          assert.deepStrictEqual(state.global_bindings, []);
          assert.strictEqual((yield* device.sync()).status, "clean");
        }
        assert.isFalse(
          (yield* remote)!.manifest.collections.some((item) => item.collection_id === removed),
        );
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("adoption recovers a home whose Library vanished without deleting anything", () =>
  Effect.gen(function* () {
    const { a, b, resetRemote, remoteCollections } = yield* devices;
    yield* a.retain("first");
    yield* a.sync();
    yield* b.sync();
    yield* b.retain("second");
    yield* resetRemote;

    assert.strictEqual((yield* a.sync()).status, "base_mismatch");
    assert.strictEqual((yield* a.sync({ adopt: true })).status, "pushed");
    assert.strictEqual((yield* b.sync()).status, "base_mismatch");
    assert.strictEqual((yield* b.sync({ adopt: true })).status, "merged");
    assert.strictEqual((yield* remoteCollections).length, 2);
    assert.strictEqual((yield* a.sync()).status, "merged");
    assert.strictEqual((yield* a.state).collections.length, 2);
    assert.strictEqual((yield* b.sync()).status, "clean");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
