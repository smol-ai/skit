import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import { currentLibraryManifest, type LibraryManifest } from "@smolai/skit-core";
import { devices } from "./helpers/library-sync-devices.js";

// An absent remote, an existing remote holding an empty Library, an absent state.json, an empty
// state.json, and an empty accepted base are five different facts. Each row's expected outcome is
// read from the Preflight, Push, Pull, Clean and Adoption gate tables in
// docs/library-sync-outcomes.md.

type Homes = Effect.Success<typeof devices>;
type Device = Homes["a"];

const empty: LibraryManifest = currentLibraryManifest({
  collections: [],
  skills: [],
  retained_copies: [],
  acquisitions: [],
  snapshot_digests: [],
  bindings: [],
});

/**
 * Every path inside a device's home and projection root, with its file identity and bytes. An atomic
 * rewrite of identical bytes changes the inode, so this also catches writes that change nothing.
 */
const capture = Effect.fn("Test.captureDevice")(function* (device: Device) {
  const fs = yield* FileSystem.FileSystem;
  const entries: Record<string, string> = {};
  const walk = Effect.fn("Test.capturePath")(function* (
    path: string,
  ): Effect.fn.Return<void, unknown, FileSystem.FileSystem> {
    const info = yield* fs.stat(path);
    const identity = `${info.mode}:${Option.getOrUndefined(info.ino)}`;
    // The writer lock's file comes and goes inside the home, so a directory's mtime is not a write;
    // its entries are captured individually instead.
    if (info.type === "Directory") {
      entries[path] = `directory:${identity}`;
      for (const name of yield* fs.readDirectory(path)) yield* walk(join(path, name));
    } else
      entries[path] =
        `${info.type}:${identity}:${Option.getOrUndefined(info.mtime)?.getTime()}:${Buffer.from(yield* fs.readFile(path)).toString("base64")}`;
  });
  // Taking the writer lock may create an empty home; only what a root holds is durable.
  for (const root of [device.home, device.root])
    if (yield* fs.exists(root))
      for (const name of yield* fs.readDirectory(root)) yield* walk(join(root, name));
  return entries;
});

/** Assert that a sync wrote nothing on the device or the Registry. */
const unwritten = Effect.fn("Test.unwritten")(function* ({ server }: Homes, device: Device) {
  const files = yield* capture(device);
  const stored = server.stored;
  return Effect.gen(function* () {
    assert.deepStrictEqual(yield* capture(device), files);
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

/** A state.json that exists and holds an empty Library, as a fresh home publishes one. */
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
    assert.isFalse(yield* homes.fs.exists(join(a.home, "state.json")));
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

it.effect("absent R with ancestry: base_mismatch, never a push of the old Library", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, server } = homes;
    yield* a.retain("first");
    yield* a.sync();
    yield* homes.resetRemote;
    const unchanged = yield* unwritten(homes, a);
    for (const apply of [false, true]) {
      assert.deepStrictEqual(yield* a.sync({ apply }), { status: "base_mismatch" });
      yield* unchanged;
    }
    assert.strictEqual(server.remote, null);
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
      [state.collections, state.skills, state.acquisitions, state.retained_copies],
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
    assert.strictEqual((yield* a.sync()).status, "clean");
    assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, head.revision_id);
    assert.strictEqual(server.writes, 1);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("an anchored home that matches the remote: clean with zero writes", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, server } = homes;
    yield* a.retain("first");
    yield* a.edit((state) => ({
      ...state,
      global_bindings: [
        {
          scope: { kind: "global" },
          entries: [{ kind: "skill", skill_id: state.skills[0]!.skill_id }],
        },
      ],
    }));
    yield* a.project();
    assert.strictEqual((yield* a.sync()).status, "pushed");
    assert.strictEqual((yield* a.sync()).status, "clean");
    const statePath = join(a.home, "state.json");
    const unchanged = yield* unwritten(homes, a);
    assert.strictEqual((yield* a.sync({ apply: false })).status, "clean");
    yield* unchanged;
    const bytes = yield* homes.fs.readFile(statePath);
    const inode = (yield* homes.fs.stat(statePath)).ino;
    const { [statePath]: _before, ...others } = yield* capture(a);
    const result = yield* a.sync();
    assert.deepStrictEqual(result, {
      status: "clean",
      changed: false,
      revision_id: server.remote!.revision_id,
      projected: 0,
      retired: 0,
    });
    assert.deepStrictEqual(yield* homes.fs.readFile(statePath), bytes);
    const { [statePath]: _after, ...othersAfter } = yield* capture(a);
    assert.deepStrictEqual(othersAfter, others);
    // BUG characterization: an applied clean sync republishes identical state, replacing the file.
    // A clean no-op should write nothing; when sync unification skips the publish once B already
    // equals R and the state is unchanged, this inode stays the same and `unchanged` holds here too.
    assert.notDeepEqual((yield* homes.fs.stat(statePath)).ino, inode);
    assert.strictEqual(server.writes, 1);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("empty R is not absent R: a Library without ancestry requires adoption", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, server } = homes;
    yield* a.retain("first");
    yield* emptyRemote(homes);
    const head = server.remote!;
    const unchanged = yield* unwritten(homes, a);
    for (const apply of [false, true]) {
      assert.deepStrictEqual(yield* a.sync({ apply }), {
        status: "adoption_required",
        revision_id: head.revision_id,
      });
      yield* unchanged;
    }
    // Adopting merges against an empty base, so it only adds this home's records.
    const local = yield* a.state;
    assert.strictEqual((yield* a.sync({ adopt: true })).status, "merged");
    assert.deepStrictEqual(
      server.remote!.manifest.collections.map((item) => item.collection_id),
      local.collections.map((item) => item.collection_id),
    );
    assert.strictEqual(server.writes, 2);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("empty L is not absent L: an empty state without ancestry requires adoption", () =>
  Effect.gen(function* () {
    const homes = yield* devices;
    const { a, b, server } = homes;
    yield* a.retain("first");
    yield* a.sync();
    const head = server.remote!;
    yield* emptyLocal(b);
    const unchanged = yield* unwritten(homes, b);
    for (const apply of [false, true]) {
      assert.deepStrictEqual(yield* b.sync({ apply }), {
        status: "adoption_required",
        revision_id: head.revision_id,
      });
      yield* unchanged;
    }
    // An empty base never infers a deletion: adopting keeps every remote Collection.
    assert.strictEqual((yield* b.sync({ adopt: true })).status, "merged");
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
    yield* a.retain("first");
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
    const first = yield* a.retain("first");
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
