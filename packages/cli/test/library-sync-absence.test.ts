import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { join } from "node:path";
import { Effect } from "effect";
import { type LibraryManifest } from "@smolai/skit-core/library";
import { captureDisk, diskChanges, noDiskChanges } from "./helpers/disk-snapshot.js";
import { devices } from "./helpers/library-sync-devices.js";

// An absent remote, an existing remote holding an empty Library, an absent state.json, an empty
// state.json, and an empty accepted base are five different facts. Each row's expected outcome is
// read from the Preflight, Push, Pull, Clean and empty-base merge tables in
// docs/library-sync-outcomes.md.

type Homes = Effect.Success<typeof devices>;
type Device = Homes["a"];

const empty: LibraryManifest = {
  schema: "skit.library.v8",
  collections: [],
  skills: [],
  collection_versions: [],
  imports: [],
  snapshot_digests: [],
  enabled: [],
};

/**
 * Assert that a sync published no local state, sent the Registry no write request, and left the
 * durable state of both unchanged. The counters see every save and write request, including
 * an identical rewrite in place or an idempotent write the Registry answers with its head. The
 * snapshot captures file identity, so it also sees an atomic replacement of identical bytes. Taking
 * the writer lock creates the home when it did not exist yet, as the fault-matrix rows allow; it
 * must stay empty.
 */
const unwritten = Effect.fn("Test.unwritten")(function* ({ server }: Homes, device: Device) {
  const before = yield* captureDisk(device.disk, { identity: true });
  const stored = server.stored;
  const saves = device.saves;
  const writeRequests = server.writeRequests;
  return Effect.gen(function* () {
    assert.strictEqual(device.saves, saves);
    assert.strictEqual(server.writeRequests, writeRequests);
    const changes = yield* diskChanges(before);
    assert.deepStrictEqual(
      {
        ...changes,
        created: changes.created.filter(
          (item) =>
            !(
              item.path.length === 1 &&
              item.path[0] === device.home &&
              item.after.type === "directory"
            ),
        ),
      },
      noDiskChanges,
    );
    assert.deepStrictEqual(server.stored, stored);
  });
});

/** Another home commits a Library holding nothing, so the remote exists but is empty. */
const emptyRemote = ({ server }: Homes) =>
  Effect.sync(() => {
    assert.strictEqual(
      server.respond("PUT", "/api/library/portable", {
        expected_revision_id: null,
        manifest: empty,
      }).status,
      200,
    );
  });

/** A state.json that exists and holds an empty Library, as a fresh home saves one. */
const emptyLocal = (device: Device) => device.edit((state) => state);

it.effect("absent R and absent L: clean, and nothing is created anywhere", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, server } = homes;
    const unchanged = yield* unwritten(homes, a);
    for (const apply of [false, true]) {
      const result = yield* a.sync({ apply });
      assert.deepStrictEqual(result, { status: "clean", changed: false });
      yield* unchanged;
    }
    // A clean sync with no local or remote Library does not acquire a writer or create home.
    assert.isFalse(yield* homes.fs.exists(a.home));
    assert.strictEqual(server.remote, null);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("absent R and empty L: an empty Library is pushed and anchored", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, server } = homes;
    yield* emptyLocal(a);
    assert.strictEqual((yield* a.sync({ apply: false })).status, "push_ready");
    assert.strictEqual(server.remote, null);
    assert.strictEqual((yield* a.sync()).status, "pushed");
    const head = server.remote;
    assert.ok(head);
    assert.deepStrictEqual(head.manifest, empty);
    const state = yield* a.state;
    assert.strictEqual(state.sync_ancestry?.revision_id, head.revision_id);
    assert.deepStrictEqual(state.sync_ancestry?.base_manifest, empty);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("absent R with ancestry: preview is read-only and apply creates a new Library", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, server } = homes;
    yield* a.importSource("first");
    yield* a.sync();
    yield* homes.resetRemote;
    const unchanged = yield* unwritten(homes, a);
    const preview = yield* a.sync({ apply: false });
    assert.strictEqual(preview.status, "push_ready");
    assert.ok("merge_base" in preview);
    assert.strictEqual(preview.merge_base, "empty-different-library");
    yield* unchanged;
    assert.strictEqual(server.remote, null);
    const applied = yield* a.sync();
    assert.strictEqual(applied.status, "pushed");
    assert.ok("merge_base" in applied);
    assert.strictEqual(applied.merge_base, "empty-different-library");
    assert.strictEqual(server.remote?.manifest.collections.length, 1);
    assert.strictEqual((yield* a.sync()).status, "clean");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("empty R and absent L: the empty Library is pulled and anchored", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, server } = homes;
    yield* emptyRemote(homes);
    const head = server.remote!;
    const unchanged = yield* unwritten(homes, a);
    assert.strictEqual((yield* a.sync({ apply: false })).status, "pull_ready");
    yield* unchanged;
    assert.strictEqual((yield* a.sync()).status, "pulled");
    const state = yield* a.state;
    assert.deepStrictEqual(
      [state.collections, state.skills, state.imports, state.collection_versions],
      [[], [], [], []],
    );
    assert.strictEqual(state.sync_ancestry?.revision_id, head.revision_id);
    assert.strictEqual(server.writes, 1);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("empty R and empty L without ancestry: clean, anchoring only local ancestry", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, server } = homes;
    yield* emptyRemote(homes);
    yield* emptyLocal(a);
    const head = server.remote!;
    const unchanged = yield* unwritten(homes, a);
    assert.strictEqual((yield* a.sync({ apply: false })).status, "clean");
    yield* unchanged;
    const operations = (yield* a.state).operations;
    const writeRequests = server.writeRequests;
    assert.strictEqual((yield* a.sync()).status, "clean");
    const anchored = yield* a.state;
    assert.strictEqual(anchored.operations.length, operations.length + 1);
    assert.deepStrictEqual(anchored.operations.slice(0, -1), operations);
    assert.strictEqual(anchored.operations.at(-1)?._tag, "Done");
    assert.deepStrictEqual(
      anchored.operations.at(-1)?.steps.map((step) => step.status),
      ["Done", "Done", "Done"],
    );
    assert.strictEqual(server.writeRequests, writeRequests);
    assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, head.revision_id);
    assert.strictEqual(server.writes, 1);
    const saves = a.saves;
    assert.strictEqual((yield* a.sync()).status, "clean");
    assert.strictEqual(a.saves, saves);
    assert.deepStrictEqual(yield* a.state, anchored);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

/** A home whose state, installed skills and ancestry already match the remote head. */
const anchored = Effect.fn("Test.anchoredHome")(function* (device: Device) {
  yield* device.importSource("first");
  yield* device.edit((state) => ({
    ...state,
    enabled: [{ skill: state.skills[0]!.skill_id }],
  }));
  yield* device.project();
  assert.strictEqual((yield* device.sync()).status, "pushed");
  assert.strictEqual((yield* device.sync()).status, "clean");
});

it.effect("an anchored home that matches the remote: a clean preview writes nothing", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    yield* anchored(homes.a);
    const unchanged = yield* unwritten(homes, homes.a);
    assert.strictEqual((yield* homes.a.sync({ apply: false })).status, "clean");
    yield* unchanged;
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

// A clean sync whose ancestry already names the head has nothing to anchor, and reconciliation of
// Installed skills that are already current save nothing either.
it.effect("an anchored home that matches the remote: an applied clean writes nothing", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, server } = homes;
    yield* anchored(a);
    const unchanged = yield* unwritten(homes, a);
    assert.deepStrictEqual(yield* a.sync(), {
      status: "clean",
      changed: false,
      revision_id: server.remote!.revision_id,
      installed: 0,
      uninstalled: 0,
    });
    yield* unchanged;
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("empty R is not absent R: a Library without ancestry merges add-only", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, server } = homes;
    yield* a.importSource("first");
    yield* emptyRemote(homes);
    const head = server.remote!;
    const unchanged = yield* unwritten(homes, a);
    const preview = yield* a.sync({ apply: false });
    assert.strictEqual(preview.status, "merge_ready");
    assert.ok("merge_base" in preview);
    assert.strictEqual(preview.merge_base, "empty-first-sync");
    assert.ok("revision_id" in preview);
    assert.strictEqual(preview.revision_id, head.revision_id);
    yield* unchanged;
    // Merging against an empty base, so it only adds this home's records.
    const local = yield* a.state;
    assert.strictEqual((yield* a.sync()).status, "merged");
    assert.deepStrictEqual(
      server.remote!.manifest.collections.map((item) => item.collection_id),
      local.collections.map((item) => item.collection_id),
    );
    assert.strictEqual(server.writes, 2);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("empty L is not absent L: an empty state without ancestry keeps remote records", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, b, server } = homes;
    yield* a.importSource("first");
    yield* a.sync();
    const head = server.remote!;
    yield* emptyLocal(b);
    const unchanged = yield* unwritten(homes, b);
    const preview = yield* b.sync({ apply: false });
    assert.strictEqual(preview.status, "merge_ready");
    assert.ok("merge_base" in preview);
    assert.strictEqual(preview.merge_base, "empty-first-sync");
    assert.ok("revision_id" in preview);
    assert.strictEqual(preview.revision_id, head.revision_id);
    yield* unchanged;
    // An empty base never infers a deletion: merging keeps every remote Collection.
    assert.strictEqual((yield* b.sync()).status, "merged");
    assert.deepStrictEqual(server.remote, head);
    assert.deepStrictEqual(
      (yield* b.state).collections.map((item) => item.collection_id),
      head.manifest.collections.map((item) => item.collection_id),
    );
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("absent L with a non-empty R pulls", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, b, server } = homes;
    yield* a.importSource("first");
    yield* a.sync();
    assert.strictEqual((yield* b.sync()).status, "pulled");
    assert.strictEqual(
      (yield* b.state).collections[0]?.collection_id,
      server.remote!.manifest.collections[0]?.collection_id,
    );
    assert.strictEqual(server.writes, 1);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("empty L with an accepted base removes what the base held, and only that", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, b, server } = homes;
    const first = yield* a.importSource("first");
    yield* a.sync();
    yield* b.sync();
    yield* b.remove(first.collection.collection_id);
    const local = yield* b.state;
    assert.deepStrictEqual(local.collections, []);
    assert.ok(local.sync_ancestry);
    assert.strictEqual((yield* b.sync()).status, "merged");
    assert.deepStrictEqual(server.remote!.manifest, empty);
    assert.strictEqual((yield* a.sync()).status, "merged");
    assert.deepStrictEqual((yield* a.state).collections, []);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect(
  "a recreated Library restores remotely held Skills and preserves independent device selection",
  () =>
    Effect.gen(function* () {
      const homes = yield* devices;
      const { a, b, fs, resetRemote } = homes;
      const removed = yield* a.importSource("removed");
      const kept = yield* a.importSource("kept");
      yield* a.edit((state) => ({
        ...state,
        enabled: [
          { collection: removed.collection.collection_id },
          { collection: kept.collection.collection_id },
        ],
      }));
      yield* a.sync();
      yield* b.sync();
      yield* a.sync({ deviceSelection: { skills: [kept.skills[0]!.skill_id], collections: [] } });
      yield* a.remove(removed.collection.collection_id);
      const local = yield* a.state;
      assert.strictEqual(local.collections.length, 1);
      yield* resetRemote;
      assert.strictEqual((yield* b.sync()).status, "pushed");
      const unchanged = yield* unwritten(homes, a);
      const preview = yield* a.sync({ apply: false });
      assert.strictEqual(preview.status, "merge_ready");
      assert.ok("merge_base" in preview);
      assert.strictEqual(preview.merge_base, "empty-different-library");
      yield* unchanged;
      assert.strictEqual((yield* a.sync()).status, "merged");
      const merged = yield* a.state;
      assert.strictEqual(merged.collections.length, 2);
      assert.isTrue(merged.skills.some((skill) => skill.skill_id === removed.skills[0]!.skill_id));
      assert.deepStrictEqual(merged.device_skill_selection, local.device_skill_selection);
      assert.strictEqual(merged.enabled.length, 2);
      assert.isFalse(yield* fs.exists(join(a.root, "removed")));
      assert.strictEqual(yield* fs.readFileString(join(a.root, "kept", "SKILL.md")), "kept\n");
      assert.strictEqual((yield* a.sync()).status, "clean");
      assert.strictEqual((yield* b.sync()).status, "clean");
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a different recorded Registry origin uses an empty base without erasing records", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, b } = homes;
    const first = yield* a.importSource("first");
    yield* a.sync();
    yield* b.sync();
    yield* a.remove(first.collection.collection_id);
    yield* a.edit((state) => ({
      ...state,
      sync_ancestry: { ...state.sync_ancestry!, origin: "https://another-registry.example" },
    }));
    const unchanged = yield* unwritten(homes, a);
    const preview = yield* a.sync({ apply: false });
    assert.strictEqual(preview.status, "merge_ready");
    assert.ok("merge_base" in preview);
    assert.strictEqual(preview.merge_base, "empty-different-library");
    yield* unchanged;
    assert.strictEqual((yield* a.sync()).status, "merged");
    const after = yield* a.state;
    assert.strictEqual(after.collections.length, 1);
    assert.notStrictEqual(after.sync_ancestry?.origin, "https://another-registry.example");
    assert.strictEqual((yield* a.sync()).status, "clean");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
