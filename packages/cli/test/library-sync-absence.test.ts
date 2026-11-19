import { describe } from "@effect/vitest";
import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { join } from "node:path";
import { Effect } from "effect";
import { type LibraryManifest } from "@smolai/skit-core/library";

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

/** Pair domain/history equality with user-file identity and Registry write observations.
 * SQLite reader-side WAL activity is allowed; no Library data change is allowed.
 */
const unwritten = Effect.fn("Test.unwritten")(function* ({ server }: Homes, device: Device) {
  const unchanged = yield* device.unchanged;
  const stored = server.stored;
  const saves = device.saves;
  const writeRequests = server.writeRequests;
  return {
    check: Effect.gen(function* () {
      yield* unchanged.check;
      assert.strictEqual(device.saves, saves);
      assert.strictEqual(server.writeRequests, writeRequests);
      assert.deepStrictEqual(server.stored, stored);
    }),
  };
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

describe("skit sync", () => {
  describe("Connecting and previewing", () => {
    describe("A new Library keeps records already held by the Registry.", () => {
      it.effect("absent R and absent L: clean, and nothing is created anywhere", () =>
        Effect.gen(function* () {
          const homes = yield* devices;
          const { a, server } = homes;
          const unchanged = yield* unwritten(homes, a);
          for (const apply of [false, true]) {
            const result = yield* a.sync({ apply });
            assert.deepStrictEqual(result, { status: "clean", changed: false });
            yield* unchanged.check;
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

      it.effect("empty R and absent L: the empty Library is pulled and anchored", () =>
        Effect.gen(function* () {
          const homes = yield* devices;
          const { a, server } = homes;
          yield* emptyRemote(homes);
          const head = server.remote!;
          const unchanged = yield* unwritten(homes, a);
          assert.strictEqual((yield* a.sync({ apply: false })).status, "pull_ready");
          yield* unchanged.check;
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
          yield* unchanged.check;
          const history = yield* (yield* a.owner()).history;
          const writeRequests = server.writeRequests;
          assert.strictEqual((yield* a.sync()).status, "clean");
          const anchored = yield* a.state;
          const anchoredHistory = yield* (yield* a.owner()).history;
          assert.deepStrictEqual(anchoredHistory.operations, history.operations);
          assert.strictEqual(anchoredHistory.events.length, history.events.length + 1);
          assert.isTrue(
            anchoredHistory.events
              .at(-1)
              ?.changes.some((change) => change.action === "operation-Done"),
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
          yield* unchanged.check;
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
          yield* unchanged.check;
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

      it.effect(
        "empty L is not absent L: an empty state without ancestry keeps remote records",
        () =>
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
            yield* unchanged.check;
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
            yield* a.sync({
              deviceSelection: { skills: [kept.skills[0]!.skill_id], collections: [] },
            });
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
            yield* unchanged.check;
            assert.strictEqual((yield* a.sync()).status, "merged");
            const merged = yield* a.state;
            assert.strictEqual(merged.collections.length, 2);
            assert.isTrue(
              merged.skills.some((skill) => skill.skill_id === removed.skills[0]!.skill_id),
            );
            assert.deepStrictEqual(merged.device_skill_selection, local.device_skill_selection);
            assert.strictEqual(merged.enabled.length, 2);
            assert.isFalse(yield* fs.exists(join(a.root, "removed")));
            assert.strictEqual(
              yield* fs.readFileString(join(a.root, "kept", "SKILL.md")),
              "kept\n",
            );
            assert.strictEqual((yield* a.sync()).status, "clean");
            assert.strictEqual((yield* b.sync()).status, "clean");
          }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );

      it.effect(
        "a different recorded Registry origin uses an empty base without erasing records",
        () =>
          Effect.gen(function* () {
            const homes = yield* devices;
            const { a, b } = homes;
            const first = yield* a.importSource("first");
            yield* a.sync({ origin: "https://another-registry.example" });
            yield* b.sync();
            yield* a.remove(first.collection.collection_id);
            const unchanged = yield* unwritten(homes, a);
            const preview = yield* a.sync({ apply: false });
            assert.strictEqual(preview.status, "merge_ready");
            assert.ok("merge_base" in preview);
            assert.strictEqual(preview.merge_base, "empty-different-library");
            yield* unchanged.check;
            assert.strictEqual((yield* a.sync()).status, "merged");
            const after = yield* a.state;
            assert.strictEqual(after.collections.length, 1);
            assert.notStrictEqual(after.sync_ancestry?.origin, "https://another-registry.example");
            assert.strictEqual((yield* a.sync()).status, "clean");
          }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );

      it.effect("Library sync creates an absent Registry Library from its saved ancestry", () =>
        Effect.gen(function* () {
          const homes = yield* devices;

          const { a, server } = homes;

          yield* a.importSource("first");

          yield* a.sync();

          yield* homes.resetRemote;

          const applied = yield* a.sync();

          assert.strictEqual(applied.status, "pushed");

          assert.ok("merge_base" in applied);

          assert.strictEqual(applied.merge_base, "empty-different-library");

          assert.strictEqual(server.remote?.manifest.collections.length, 1);

          assert.strictEqual((yield* a.sync()).status, "clean");
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );
    });
  });
});

describe("skit sync", () => {
  describe("Connecting and previewing", () => {
    describe("Preview leaves the proposed Library sync unapplied.", () => {
      it.effect("Library sync preview leaves an absent Registry Library untouched", () =>
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

          yield* unchanged.check;

          assert.strictEqual(server.remote, null);
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );
    });
  });
});

describe("skit sync", () => {
  describe("Connecting and previewing", () => {
    describe("Preview leaves the proposed Library sync unapplied.", () => {
      it.effect("an anchored home that matches the remote: a clean preview writes nothing", () =>
        Effect.gen(function* () {
          const homes = yield* devices;
          yield* anchored(homes.a);
          const unchanged = yield* unwritten(homes, homes.a);
          assert.strictEqual((yield* homes.a.sync({ apply: false })).status, "clean");
          yield* unchanged.check;
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );
    });
  });
});

describe("skit sync", () => {
  describe("Recovering interrupted work", () => {
    describe("Sync sends removals made since this Library last synced.", () => {
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
    });
  });
});

it.effect(
  "a device counts its final committed write before another writable connection opens",
  () =>
    Effect.gen(function* () {
      const { a, events } = yield* devices;
      assert.strictEqual(a.saves, 0);
      yield* a.importSource("first");
      assert.strictEqual(a.saves, 1);
      assert.deepStrictEqual(events, ["save a"]);
      const before = a.saves;
      assert.strictEqual((yield* a.sync({ apply: false })).status, "push_ready");
      assert.strictEqual(a.saves, before);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
