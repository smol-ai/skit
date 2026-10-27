import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Effect, Schema, Exit, type Layer, type Scope } from "effect";
import type { SkillId } from "@smolai/skit-core";
import { join } from "node:path";
import {
  LibraryState,
  libraryStoreLayer,
  InvalidLibraryState,
  captureSnapshotArchive,
  deterministicTreeHash,
  retainedTreePath,
  libraryManifestFromLocalState,
} from "@smolai/skit-core";
import { LibraryChangedOnServer, RegistryUnreachable } from "../src/registry/failures.js";
import {
  LibraryApiRejected,
  LibraryManifestTooNew,
} from "../src/workflows/library/library-sync-api.js";
import { prepareSyncDeviceTransition } from "../src/workflows/library/library-sync-installed-skills.js";
import { SyncLocalChanged } from "../src/workflows/library/library-sync.js";
import {
  assertDiskUnchanged,
  captureDisk,
  diskChanges,
  noDiskChanges,
  type DiskSnapshot,
} from "./helpers/disk-snapshot.js";
import { devices } from "./helpers/library-sync-devices.js";

type Homes = Effect.Success<typeof devices>;

/** A row stopped before save may leave orphan originals, and nothing else may change. */
const onlyOrphanOriginals = Effect.fn("Test.onlyOrphanOriginals")(function* (
  before: DiskSnapshot,
  home: string,
) {
  const changes = yield* diskChanges(before);
  assert.deepStrictEqual({ ...changes, created: [] }, noDiskChanges);
  // The writer lock creates a home that did not exist yet.
  for (const { path, after } of changes.created)
    assert.isTrue(
      path[0] === home &&
        ((path.length === 1 && after.type === "directory") || path[1] === "originals"),
      path.join("/"),
    );
});

const seed = Effect.fn("Test.seedSyncHomes")(function* ({ a, b }: Homes) {
  yield* a.retain("first");
  yield* a.edit((state) => ({
    ...state,
    global_bindings: [
      {
        scope: { kind: "global" },
        entries: [{ kind: "skill", skill_id: state.skills[0]!.skill_id }],
        invocation_policies: { [state.skills[0]!.skill_id]: "explicit" },
      },
    ],
  }));
  yield* a.project();
  yield* a.sync();
  yield* b.sync();
});

const cases: readonly {
  row: string;
  run: (
    homes: Homes,
  ) => Effect.Effect<void, unknown, Layer.Success<typeof testPlatformLayer> | Scope.Scope>;
}[] = [
  {
    row: "Preflight: local_bytes_changed preserves every store",
    run: (homes) =>
      Effect.gen(function* () {
        const { a, server } = homes;
        yield* seed(homes);
        yield* a.corruptOriginal;
        const unchanged = yield* captureDisk(a.disk);
        const before = server.stored;
        assert.strictEqual((yield* a.sync()).status, "local_bytes_changed");
        yield* assertDiskUnchanged(unchanged);
        assert.deepStrictEqual(server.stored, before);
      }),
  },
  {
    row: "Preflight: base_mismatch",
    run: (homes) =>
      Effect.gen(function* () {
        const { a, resetRemote, server } = homes;
        yield* seed(homes);
        yield* resetRemote;
        const unchanged = yield* captureDisk(a.disk);
        const before = server.stored;
        assert.strictEqual((yield* a.sync()).status, "base_mismatch");
        yield* assertDiskUnchanged(unchanged);
        assert.deepStrictEqual(server.stored, before);
      }),
  },
  {
    row: "Push: before P2 (failed upload)",
    run: ({ a, inject, server }) =>
      Effect.gen(function* () {
        yield* a.retain("first");
        const unchanged = yield* captureDisk(a.disk);
        inject({ _tag: "FailUpload" });
        assert.ok((yield* Effect.flip(a.sync())) instanceof LibraryApiRejected);
        yield* assertDiskUnchanged(unchanged);
        assert.strictEqual(server.remote, null);
        assert.strictEqual((yield* a.sync()).status, "pushed");
      }),
  },
  {
    row: "Push: P2 loses the CAS on the first push",
    run: ({ a, b, inject, server }) =>
      Effect.gen(function* () {
        yield* a.retain("from-a");
        yield* b.retain("from-b");
        // The competitor uploads its bytes and commits before A's null-base CAS.
        const competingState = yield* b.state;
        const archive = yield* captureSnapshotArchive(
          retainedTreePath(join(b.home, "originals"), competingState.retained_copies[0]!.digest),
        );
        assert.strictEqual(server.respond("POST", "/api/library/snapshots", archive).status, 200);
        inject({
          _tag: "CompetingWrite",
          manifest: yield* libraryManifestFromLocalState(competingState),
        });
        const unchanged = yield* captureDisk(a.disk);
        assert.instanceOf(yield* Effect.flip(a.sync()), LibraryChangedOnServer);
        yield* assertDiskUnchanged(unchanged);
        const winner = server.remote;
        assert.ok(winner);
        assert.strictEqual((yield* a.sync()).status, "adoption_required");
        yield* assertDiskUnchanged(unchanged);
        assert.deepStrictEqual(server.remote, winner);
        assert.strictEqual((yield* a.sync({ adopt: true })).status, "merged");
        assert.strictEqual((yield* a.state).collections.length, 2);
      }),
  },
  {
    row: "Push: HTTP 500 after commit differs from a lost transport response",
    run: ({ a, inject, server }) =>
      Effect.gen(function* () {
        yield* a.retain("first");
        const unchanged = yield* captureDisk(a.disk);
        inject({ _tag: "ErrorAfterCommit" });
        const error = yield* Effect.flip(a.sync());
        assert.strictEqual(error._tag, "Library.LibraryApiRejected");
        if (error._tag === "Library.LibraryApiRejected") assert.strictEqual(error.status, 500);
        yield* assertDiskUnchanged(unchanged);
        assert.ok(server.remote);
        assert.strictEqual((yield* a.sync()).status, "clean");
      }),
  },
  {
    row: "Push: P2 response lost before P4",
    run: ({ a, inject, server }) =>
      Effect.gen(function* () {
        yield* a.retain("first");
        const unchanged = yield* captureDisk(a.disk);
        inject({ _tag: "DropAfterCommit" });
        assert.ok((yield* Effect.flip(a.sync())) instanceof RegistryUnreachable);
        yield* assertDiskUnchanged(unchanged);
        const committed = server.remote;
        assert.ok(committed);
        assert.strictEqual((yield* a.sync()).status, "clean");
        assert.deepStrictEqual(server.remote, committed);
        assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, committed.revision_id);
      }),
  },
  {
    row: "Push: after P2 before P4 (failed local publish)",
    run: ({ a, inject, server }) =>
      Effect.gen(function* () {
        yield* a.retain("first");
        const unchanged = yield* captureDisk(a.disk);
        inject({ _tag: "FailSave", anchoredOnly: false });
        assert.instanceOf(yield* Effect.flip(a.sync()), InvalidLibraryState);
        yield* assertDiskUnchanged(unchanged);
        assert.ok(server.remote);
        assert.strictEqual((yield* a.sync()).status, "clean");
        assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, server.remote!.revision_id);
      }),
  },
  {
    row: "Push: P2 response lost, then another home writes before retry",
    run: ({ a, b, inject, server }) =>
      Effect.gen(function* () {
        yield* a.retain("first");
        const unchanged = yield* captureDisk(a.disk);
        inject({ _tag: "DropAfterCommit" });
        assert.ok((yield* Effect.flip(a.sync())) instanceof RegistryUnreachable);
        yield* assertDiskUnchanged(unchanged);
        yield* b.sync();
        yield* b.retain("second");
        yield* b.sync();
        const winner = server.remote;
        assert.strictEqual((yield* a.sync()).status, "adoption_required");
        yield* assertDiskUnchanged(unchanged);
        assert.deepStrictEqual(server.remote, winner);
        assert.strictEqual((yield* a.sync({ adopt: true })).status, "merged");
        assert.strictEqual((yield* a.state).collections.length, 2);
        assert.strictEqual((yield* b.sync()).status, "clean");
      }),
  },
  {
    row: "Pull: before U4 (failed local publish)",
    run: ({ a, b, inject, server }) =>
      Effect.gen(function* () {
        yield* a.retain("first");
        yield* a.sync();
        const unchanged = yield* captureDisk(b.disk);
        const head = server.remote;
        inject({ _tag: "FailSave", anchoredOnly: false });
        assert.instanceOf(yield* Effect.flip(b.sync()), InvalidLibraryState);
        yield* onlyOrphanOriginals(unchanged, b.home);
        assert.deepStrictEqual(server.remote, head);
        assert.strictEqual((yield* b.sync()).status, "pulled");
        assert.strictEqual((yield* b.state).sync_ancestry?.revision_id, head!.revision_id);
      }),
  },
  {
    row: "Pull: U3 finds a concurrent local write (SyncLocalChanged)",
    run: ({ fs, a, b, c, inject, server }) =>
      Effect.gen(function* () {
        yield* a.retain("remote");
        yield* a.sync();
        yield* c.retain("concurrent-local");
        const concurrent = yield* c.state;
        yield* fs.makeDirectory(b.home, { recursive: true });
        yield* fs.copy(join(c.home, "originals"), join(b.home, "originals"));
        inject({ _tag: "ChangeStateWhenHeadRead", home: b.home, state: concurrent });
        const head = server.remote;
        assert.ok((yield* Effect.flip(b.sync())) instanceof SyncLocalChanged);
        assert.strictEqual(
          yield* fs.readFileString(join(b.home, "state.json")),
          Schema.encodeSync(Schema.fromJsonString(LibraryState))(concurrent),
        );
        assert.deepStrictEqual(yield* b.state, concurrent);
        assert.deepStrictEqual(server.remote, head);
        assert.isFalse(yield* fs.exists(b.root));
      }),
  },
  {
    row: "Merge: M3 finds a concurrent local write (SyncLocalChanged)",
    run: (homes) =>
      Effect.gen(function* () {
        const { fs, a, b, inject, server } = homes;
        yield* seed(homes);
        yield* b.retain("remote-addition");
        yield* b.sync();
        const concurrent = {
          ...(yield* a.state),
          collections: (yield* a.state).collections.map((item) => ({
            ...item,
            label: "concurrent-local",
          })),
        };
        inject({ _tag: "ChangeStateWhenHeadRead", home: a.home, state: concurrent });
        const markerBefore = yield* fs.readFile(join(a.root, "first", ".skit-ownership.json"));
        const skillBefore = yield* fs.readFile(join(a.root, "first", "SKILL.md"));
        const head = server.remote;
        assert.ok((yield* Effect.flip(a.sync())) instanceof SyncLocalChanged);
        assert.strictEqual(
          yield* fs.readFileString(join(a.home, "state.json")),
          Schema.encodeSync(Schema.fromJsonString(LibraryState))(concurrent),
        );
        assert.deepStrictEqual(yield* a.state, concurrent);
        assert.deepStrictEqual(yield* fs.readFile(join(a.root, "first", "SKILL.md")), skillBefore);
        assert.deepStrictEqual(
          yield* fs.readFile(join(a.root, "first", ".skit-ownership.json")),
          markerBefore,
        );
        assert.deepStrictEqual(server.remote, head);
      }),
  },
  {
    row: "Merge: M3 stops a merge that would upload and write before either",
    run: (homes) =>
      Effect.gen(function* () {
        const { a, b, events, inject, server } = homes;
        yield* seed(homes);
        yield* b.retain("remote-addition");
        yield* b.sync();
        yield* a.retain("local-addition");
        const concurrent = yield* a.state;
        inject({
          _tag: "ChangeStateWhenHeadRead",
          home: a.home,
          state: {
            ...concurrent,
            collections: concurrent.collections.map((item) => ({
              ...item,
              label: "concurrent-local",
            })),
          },
        });
        const head = server.remote;
        events.length = 0;
        assert.instanceOf(yield* Effect.flip(a.sync()), SyncLocalChanged);
        assert.deepStrictEqual(events, []);
        assert.deepStrictEqual(server.remote, head);
      }),
  },
  {
    row: "Pull: U3 stops before writing a --keep-enabled choice",
    run: ({ fs, a, b, c, events, inject, server }) =>
      Effect.gen(function* () {
        const first = yield* a.retain("first", { name: "review" });
        const second = yield* a.retain("second", { name: "review" });
        yield* a.edit((state) => ({
          ...state,
          global_bindings: [
            {
              scope: { kind: "global" },
              entries: [first, second].map((item) => ({
                kind: "skill" as const,
                skill_id: item.skills[0]!.skill_id,
              })),
            },
          ],
        }));
        // Without enabled roots nothing collides, so the Library can be pushed as it is.
        yield* a.sync({ rootFor: () => undefined });
        yield* c.retain("concurrent-local");
        yield* fs.makeDirectory(b.home, { recursive: true });
        yield* fs.copy(join(c.home, "originals"), join(b.home, "originals"));
        inject({ _tag: "ChangeStateWhenHeadRead", home: b.home, state: yield* c.state });
        const head = server.remote;
        events.length = 0;
        assert.instanceOf(
          yield* Effect.flip(b.sync({ keepEnabled: [first.skills[0]!.skill_id] })),
          SyncLocalChanged,
        );
        assert.deepStrictEqual(events, []);
        assert.deepStrictEqual(server.remote, head);
      }),
  },
  {
    row: "Merge: M5 loses the CAS (L, B, projections unchanged)",
    run: (homes) =>
      Effect.gen(function* () {
        const { a, b, inject, server } = homes;
        yield* seed(homes);
        yield* a.retain("from-a");
        yield* b.retain("from-b");
        yield* b.sync();
        inject({
          _tag: "CompetingWrite",
          manifest: {
            ...server.remote!.manifest,
            collections: server.remote!.manifest.collections.map((item) => ({
              ...item,
              label: "competing",
            })),
          },
        });
        const unchanged = yield* captureDisk(a.disk);
        assert.instanceOf(yield* Effect.flip(a.sync()), LibraryChangedOnServer);
        yield* onlyOrphanOriginals(unchanged, a.home);
        const winner = server.remote!;
        assert.strictEqual((yield* a.sync()).status, "merged");
        assert.strictEqual((yield* a.state).collections.length, 3);
        assert.includeMembers(
          server.remote!.manifest.collections.map((item) => item.collection_id),
          winner.manifest.collections.map((item) => item.collection_id),
        );
        assert.deepStrictEqual((yield* a.state).global_bindings[0]!.invocation_policies, {
          [(yield* a.state).skills.find((item) => item.name === "first")!.skill_id]: "explicit",
        });
      }),
  },
  {
    row: "Merge: after M5 before M7 (failed local publish)",
    run: (homes) =>
      Effect.gen(function* () {
        const { a, b, inject, server } = homes;
        yield* seed(homes);
        yield* a.retain("from-a");
        yield* b.retain("from-b");
        yield* b.sync();
        const unchanged = yield* captureDisk(a.disk);
        inject({ _tag: "FailSave", anchoredOnly: false });
        assert.instanceOf(yield* Effect.flip(a.sync()), InvalidLibraryState);
        yield* onlyOrphanOriginals(unchanged, a.home);
        const committed = server.remote!;
        assert.strictEqual(committed.manifest.collections.length, 3);
        assert.strictEqual((yield* a.sync()).status, "merged");
        assert.deepStrictEqual(server.remote, committed);
        assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, committed.revision_id);
        assert.strictEqual((yield* b.sync()).status, "merged");
        assert.strictEqual((yield* b.state).collections.length, 3);
      }),
  },
  {
    row: "Merge: before M5 (failed upload after retaining remote originals)",
    run: (homes) =>
      Effect.gen(function* () {
        const { a, b, inject, server } = homes;
        yield* seed(homes);
        yield* a.retain("from-a");
        yield* b.retain("from-b");
        yield* b.sync();
        const unchanged = yield* captureDisk(a.disk);
        const head = server.remote;
        inject({ _tag: "FailUpload" });
        assert.ok((yield* Effect.flip(a.sync())) instanceof LibraryApiRejected);
        yield* onlyOrphanOriginals(unchanged, a.home);
        assert.deepStrictEqual(server.remote, head);
        assert.strictEqual((yield* a.sync()).status, "merged");
        assert.strictEqual((yield* a.state).collections.length, 3);
      }),
  },
  {
    row: "Adoption gate: adoption_required writes nothing",
    run: ({ a, b, server }) =>
      Effect.gen(function* () {
        yield* a.retain("remote");
        yield* a.sync();
        yield* b.retain("local");
        const unchanged = yield* captureDisk(b.disk);
        const before = server.stored;
        assert.strictEqual((yield* b.sync()).status, "adoption_required");
        yield* assertDiskUnchanged(unchanged);
        assert.deepStrictEqual(server.stored, before);
      }),
  },
  ...(["conflicted", "resolution_invalid", "merge_ready"] as const).map((outcome) => ({
    row: `Merge: ${outcome} writes nothing`,
    run: (homes: Homes) =>
      Effect.gen(function* () {
        const { a, b, server } = homes;
        yield* seed(homes);
        if (outcome === "conflicted") {
          yield* a.edit((state) => ({
            ...state,
            collections: state.collections.map((item) => ({ ...item, label: "from-a" })),
          }));
          yield* b.edit((state) => ({
            ...state,
            collections: state.collections.map((item) => ({ ...item, label: "from-b" })),
          }));
        } else yield* b.retain("remote-addition");
        yield* b.sync();
        const unchanged = yield* captureDisk(a.disk);
        const before = server.stored;
        const value = yield* a.sync(
          outcome === "merge_ready"
            ? { apply: false }
            : outcome === "resolution_invalid"
              ? { takeRemote: ["collection:not-a-conflict"] }
              : {},
        );
        assert.strictEqual(value.status, outcome);
        yield* assertDiskUnchanged(unchanged);
        assert.deepStrictEqual(server.stored, before);
      }),
  })),
  ...(
    [
      "Push: after P4 before P5",
      "Pull: after U4 before U5",
      "Merge: after M7 before M8",
      "Clean: after anchoring before reconciliation",
    ] as const
  ).map((row) => ({
    row,
    run: (homes: Homes) =>
      Effect.gen(function* () {
        const { fs, a, b, inject, server } = homes;
        let device = a;
        if (row.startsWith("Push")) {
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
        } else {
          yield* seed(homes);
          if (row.startsWith("Pull")) device = homes.c;
          else if (row.startsWith("Merge")) {
            yield* b.retain("remote-addition");
            yield* b.sync();
          }
          // A clean sync saves only to anchor ancestry its state lacks.
          else yield* a.edit(({ sync_ancestry: _ancestry, ...state }) => state);
        }
        const blockedRoot = join(device.home, "blocked-root");
        const expectedBytes = (yield* fs.exists(join(device.root, "first", "SKILL.md")))
          ? yield* fs.readFileString(join(device.root, "first", "SKILL.md"))
          : "first\n";
        inject({ _tag: "ObstructAfterSave", home: device.home, path: blockedRoot });
        const first = yield* Effect.exit(
          device.sync({ rootFor: (target) => (target === "agents" ? blockedRoot : undefined) }),
        );
        assert.isTrue(Exit.isFailure(first));
        const published = yield* device.state;
        assert.ok(published.sync_ancestry);
        assert.strictEqual(published.sync_ancestry.revision_id, server.remote!.revision_id);
        assert.strictEqual(published.collections.length, row.startsWith("Merge") ? 2 : 1);
        yield* fs.remove(blockedRoot);
        assert.strictEqual(
          (yield* device.sync({
            rootFor: (target) => (target === "agents" ? blockedRoot : undefined),
          })).status,
          "clean",
        );
        assert.strictEqual(
          yield* fs.readFileString(join(blockedRoot, "first", "SKILL.md")),
          expectedBytes,
        );
      }),
  })),
  ...(["Push", "Merge"] as const).map((path) => ({
    row: `${path}: an edited copy is recorded with its observed bytes before reconciliation`,
    run: (homes: Homes) =>
      Effect.gen(function* () {
        const { fs, a, b, inject } = homes;
        const first = yield* a.retain("first");
        const second = yield* a.retain("second");
        const enable = (ids: readonly SkillId[]) => (state: LibraryState) => ({
          ...state,
          global_bindings: [
            {
              scope: { kind: "global" as const },
              entries: ids.map((skill_id) => ({ kind: "skill" as const, skill_id })),
            },
          ],
        });
        yield* a.edit(enable([first.skills[0]!.skill_id]));
        yield* a.project();
        const update = { bytes: "first v2\n", retainedAt: "2026-01-02T00:00:00.000Z" };
        if (path === "Merge") {
          yield* a.sync();
          yield* b.sync();
          yield* b.retain("first", update);
          yield* b.sync();
        } else yield* a.retain("first", update);
        // An edit the selected Version would replace, and a Skill reconciliation must newly install.
        const projection = (yield* a.state).projections[0]!;
        yield* fs.writeFileString(join(projection.path, "SKILL.md"), "unretained edit\n");
        yield* a.edit(enable([first.skills[0]!.skill_id, second.skills[0]!.skill_id]));
        inject({ _tag: "ObstructAfterSave", home: a.home, path: join(a.root, "second") });
        assert.isTrue(Exit.isFailure(yield* Effect.exit(a.sync())));
        const observed = yield* deterministicTreeHash(projection.path);
        const recorded = (yield* a.state).projections.find(
          (item) => item.projection_id === projection.projection_id,
        );
        assert.deepStrictEqual(
          [recorded?.status, recorded?.observed_digest],
          ["conflicted", observed],
        );
        yield* fs.remove(join(a.root, "second"));
        assert.strictEqual((yield* a.sync()).status, "clean");
        assert.strictEqual(
          yield* fs.readFileString(join(projection.path, "SKILL.md")),
          "unretained edit\n",
        );
        assert.strictEqual(
          yield* fs.readFileString(join(a.root, "second", "SKILL.md")),
          "second\n",
        );
      }),
  })),
  {
    row: "Merge: after M5 before M7 (--take-remote must be repeated)",
    run: (homes) =>
      Effect.gen(function* () {
        const { a, b, inject, server } = homes;
        yield* seed(homes);
        const id = (yield* a.state).collections[0]!.collection_id;
        yield* a.edit((state) => ({
          ...state,
          collections: state.collections.map((item) => ({ ...item, label: "from-a" })),
        }));
        yield* b.edit((state) => ({
          ...state,
          collections: state.collections.map((item) => ({ ...item, label: "from-b" })),
        }));
        yield* b.sync();
        // Force M5 to include a local-only record as well as the resolved remote label.
        yield* a.retain("local-only");
        const unchanged = yield* captureDisk(a.disk);
        inject({ _tag: "FailSave", anchoredOnly: false });
        assert.instanceOf(
          yield* Effect.flip(a.sync({ takeRemote: [`collection:${id}`] })),
          InvalidLibraryState,
        );
        yield* assertDiskUnchanged(unchanged);
        const committed = server.remote!;
        assert.strictEqual((yield* a.sync()).status, "conflicted");
        yield* assertDiskUnchanged(unchanged);
        assert.deepStrictEqual(server.remote, committed);
        assert.strictEqual((yield* a.sync({ takeRemote: [`collection:${id}`] })).status, "merged");
        assert.deepStrictEqual(server.remote, committed);
        assert.strictEqual(
          (yield* a.state).collections.find((item) => item.collection_id === id)!.label,
          "from-b",
        );
      }),
  },
];

for (const scenario of cases)
  it.effect(`oracle row: ${scenario.row}`, () =>
    Effect.gen(function* () {
      yield* scenario.run(yield* devices);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );

// The commit order stated once in syncLibrary: snapshots are uploaded, then the head is written
// on exactly the revision this sync read, and only then is local state saved.
it.effect("oracle: every applying path commits remote before local, on the revision it read", () =>
  Effect.gen(function* () {
    const { a, b, events, server } = yield* devices;
    const committed = <A, E, R>(sync: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        events.length = 0;
        const exit = yield* Effect.exit(sync);
        // A failure after the last expected save must not leave the order looking right.
        assert.isTrue(Exit.isSuccess(exit), `${[...events]}`);
        return [...events];
      });
    yield* a.retain("first");
    assert.deepStrictEqual(yield* committed(a.sync()), ["upload", "write on null", "save a"]);
    const pushed = server.remote!.revision_id;
    assert.deepStrictEqual(yield* committed(b.sync()), ["save b"]);
    yield* b.retain("second");
    assert.deepStrictEqual(yield* committed(b.sync()), ["upload", `write on ${pushed}`, "save b"]);
    const merged = server.remote!.revision_id;
    yield* a.retain("third");
    assert.deepStrictEqual(yield* committed(a.sync()), ["upload", `write on ${merged}`, "save a"]);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

// A `--take-remote` key names a merge conflict to take remotely. A push or a pull has none, so the
// key is refused before installed-skill collisions are checked, as it is on every other path.
it.effect("a --take-remote key is refused before collision checks on a push and a pull", () =>
  Effect.gen(function* () {
    const { fs, a, b, server } = yield* devices;
    const first = yield* a.retain("first", { name: "review" });
    const second = yield* a.retain("second", { name: "review" });
    yield* a.edit((state) => ({
      ...state,
      global_bindings: [
        {
          scope: { kind: "global" },
          entries: [first, second].map((item) => ({
            kind: "skill" as const,
            skill_id: item.skills[0]!.skill_id,
          })),
        },
      ],
    }));
    const takeRemote = ["collection:not-a-conflict"];
    assert.strictEqual((yield* a.sync()).status, "conflicted");
    assert.deepStrictEqual(yield* a.sync({ takeRemote }), { status: "resolution_invalid" });
    assert.strictEqual(server.writeRequests, 0);
    // Without enabled roots nothing collides, so the Library can be pushed as it is.
    assert.strictEqual((yield* a.sync({ rootFor: () => undefined })).status, "pushed");
    const head = server.remote!;
    assert.strictEqual((yield* b.sync()).status, "conflicted");
    assert.deepStrictEqual(yield* b.sync({ takeRemote }), {
      status: "resolution_invalid",
      revision_id: head.revision_id,
    });
    assert.deepStrictEqual(server.remote, head);
    assert.isFalse(yield* fs.exists(join(b.home, "state.json")));
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

// A head another SKIT wrote in a newer manifest schema is refused before sync plans, uploads, writes
// or saves anything. Only loader maintenance may touch the home: the writer lock creates an
// absent home, and opening a legacy state.json migrates it and keeps the pre-migration file.
for (const home of ["current", "legacy", "absent"] as const)
  for (const apply of [false, true])
    it.effect(
      `oracle row: Preflight: a newer remote manifest is refused (${home} home, ${apply ? "apply" : "preview"})`,
      () =>
        Effect.gen(function* () {
          const { fs, a, inject, server } = yield* devices;
          if (home !== "absent") {
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
          }
          if (home === "legacy")
            yield* fs.writeFileString(
              join(a.home, "state.json"),
              JSON.stringify({ ...(yield* a.state), schemaVersion: 7 }),
            );
          const before = yield* captureDisk(a.disk);
          const stored = server.stored;
          const saves = a.saves;
          const writeRequests = server.writeRequests;
          inject({
            _tag: "ServeHead",
            body: JSON.parse(
              yield* fs.readFileString(
                join(import.meta.dirname, "fixtures/library-wire/portable-v8.json"),
              ),
            ),
          });
          const failure = yield* Effect.flip(a.sync({ apply }));
          assert.instanceOf(failure, LibraryManifestTooNew);
          assert.strictEqual(failure.code, "VALIDATION_FAILED");
          assert.strictEqual(a.saves, saves);
          // Snapshot uploads and Library writes are both write requests.
          assert.strictEqual(server.writeRequests, writeRequests);
          assert.deepStrictEqual(server.stored, stored);
          const changes = yield* diskChanges(before);
          const paths = (items: readonly { path: readonly string[] }[]) =>
            items.map((item) => item.path.slice(1).join("/"));
          assert.deepStrictEqual(paths(changes.deleted), []);
          if (home === "current") assert.deepStrictEqual(changes, noDiskChanges);
          if (home === "absent") {
            assert.deepStrictEqual([changes.changed, paths(changes.created)], [[], [""]]);
            assert.strictEqual(changes.created[0]!.path[0], a.home);
          }
          if (home === "legacy") {
            assert.deepStrictEqual(paths(changes.changed), ["state.json"]);
            assert.strictEqual(changes.created.length, 1);
            assert.match(paths(changes.created)[0]!, /^state\.json\.v7\.backup-/);
          }
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
    );

it.effect(
  "fresh-device sync reports completed transfers after the plan and before restoration",
  () =>
    Effect.gen(function* () {
      const { a, b } = yield* devices;
      yield* a.retain("first");
      yield* a.retain("second");
      yield* a.sync();
      const events: string[] = [];
      const ticks: number[] = [];
      const result = yield* b.sync({
        onPlan: () =>
          Effect.sync(() => {
            events.push("plan");
          }),
        restoreObserver: {
          around: (phase, operation) =>
            Effect.sync(() => {
              events.push(`start:${phase.kind}`);
            }).pipe(
              Effect.andThen(operation),
              Effect.tap(() =>
                Effect.sync(() => {
                  events.push(`complete:${phase.kind}`);
                }),
              ),
            ),
          tick: ({ phase, completed }) =>
            Effect.sync(() => {
              if (phase.kind === "download") ticks.push(completed);
            }),
        },
      });
      assert.strictEqual(result.status, "pulled");
      assert.deepStrictEqual(events, [
        "plan",
        "start:download",
        "complete:download",
        "start:retain",
        "complete:retain",
      ]);
      assert.deepStrictEqual(ticks, [0, 1, 2]);
      assert.strictEqual((yield* b.state).collections.length, 2);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a failed snapshot download retains nothing and leaves the remote unchanged", () =>
  Effect.gen(function* () {
    const { a, b, fs, inject, server } = yield* devices;
    yield* a.retain("first");
    yield* a.retain("second");
    yield* a.sync();
    const before = server.stored;
    inject({ _tag: "FailDownload", digest: server.remote!.manifest.snapshot_digests[1]! });
    const progress: string[] = [];
    const failure = yield* Effect.flip(
      b.sync({
        restoreObserver: {
          around: (phase, operation) =>
            Effect.sync(() => {
              progress.push(phase.kind);
            }).pipe(Effect.andThen(operation)),
          tick: () => Effect.void,
        },
      }),
    );
    assert.strictEqual(failure._tag, "Library.LibraryApiRejected");
    assert.notInclude(progress, "retain");
    assert.isFalse(yield* fs.exists(join(b.home, "originals")));
    assert.isFalse(yield* fs.exists(join(b.home, "state.json")));
    assert.strictEqual(b.saves, 0);
    assert.deepStrictEqual(server.stored, before);
    assert.strictEqual((yield* b.sync()).status, "pulled");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a prepared device transition cannot save into another Library home", () =>
  Effect.gen(function* () {
    const { a, b } = yield* devices;
    yield* a.retain("first");
    const state = yield* a.state;
    const manifest = yield* libraryManifestFromLocalState(state);
    const transition = yield* prepareSyncDeviceTransition({
      current: state,
      aligned: state,
      manifest,
      rootFor: undefined,
    }).pipe(Effect.provide(libraryStoreLayer({ home: a.home })));
    assert.strictEqual(transition._tag, "Ready");
    if (transition._tag !== "Ready") return;
    const before = yield* captureDisk([...a.disk, ...b.disk], { identity: true });
    const failure = yield* Effect.flip(
      transition
        .saveRestored(state, {
          origin: "https://registry.test",
          library_id: "library_test",
          revision_id: "revision_test",
          base_manifest: manifest,
        })
        .pipe(Effect.provide(libraryStoreLayer({ home: b.home }))),
    );
    assert.strictEqual(failure._tag, "LibraryChanged");
    yield* assertDiskUnchanged(before);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("sync reuses an orphan retained snapshot without downloading it", () =>
  Effect.gen(function* () {
    const { a, b, c, fs, inject, server } = yield* devices;
    yield* a.retain("first");
    yield* a.sync();
    const digest = server.remote!.manifest.snapshot_digests[0]!;
    const destination = retainedTreePath(join(b.home, "originals"), digest);
    yield* fs.makeDirectory(join(destination, ".."), { recursive: true });
    yield* fs.copy(retainedTreePath(join(a.home, "originals"), digest), destination);
    inject({ _tag: "FailDownload", digest });
    const before = yield* captureDisk(b.disk);
    const preview = yield* b.sync({ apply: false });
    assert.strictEqual(preview.status, "pull_ready");
    assert.strictEqual("snapshots" in preview ? preview.snapshots : undefined, 0);
    yield* assertDiskUnchanged(before);
    const applied = yield* b.sync();
    assert.strictEqual(applied.status, "pulled");
    assert.strictEqual("snapshots" in applied ? applied.snapshots : undefined, 0);
    assert.strictEqual((yield* b.state).collections.length, 1);
    // The unused fault still rejects a fresh device, proving b made no download request.
    assert.strictEqual((yield* c.sync().pipe(Effect.flip))._tag, "Library.LibraryApiRejected");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("sync exposes bounded completed phases in transfer and save order", () =>
  Effect.gen(function* () {
    const { a, b } = yield* devices;
    yield* a.retain("first");
    yield* a.retain("second");
    const uploaded: number[] = [];
    yield* a.sync({
      observer: {
        around: (phase, operation) =>
          operation.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (phase.kind === "upload") uploaded.push(phase.total);
              }),
            ),
          ),
        tick: () => Effect.void,
      },
    });
    assert.deepStrictEqual(uploaded, [2]);
    const completed: string[] = [];
    const retained: number[] = [];
    const result = yield* b.sync({
      observer: {
        around: (phase, operation) =>
          operation.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed.push(phase.kind);
              }),
            ),
          ),
        tick: () => Effect.void,
      },
      restoreObserver: {
        around: (phase, operation) =>
          operation.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed.push(phase.kind);
                if (phase.kind === "retain") retained.push(phase.total);
              }),
            ),
          ),
        tick: () => Effect.void,
      },
    });
    assert.strictEqual(result.status, "pulled");
    assert.deepStrictEqual(retained, [2]);
    assert.isBelow(completed.indexOf("download"), completed.indexOf("save-local"));
    assert.strictEqual(completed.at(-1), "enable");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
