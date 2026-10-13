import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Effect, Schema, Exit, type Layer, type Scope } from "effect";
import { join } from "node:path";
import {
  LibraryState,
  InvalidLibraryState,
  captureSnapshotArchiveEffect,
  retainedTreePath,
  libraryManifestFromLocalStateEffect,
} from "@smolai/skit-core";
import { LibraryChangedOnServer, RegistryUnreachable } from "../src/registry/failures.js";
import { LibraryApiRejected } from "../src/workflows/library/library-sync-api.js";
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

/** A row stopped before publication may leave orphan originals, and nothing else may change. */
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
        const archive = yield* captureSnapshotArchiveEffect(
          retainedTreePath(join(b.home, "originals"), competingState.retained_copies[0]!.digest),
        );
        assert.strictEqual(server.respond("POST", "/api/library/snapshots", archive).status, 200);
        inject({
          _tag: "CompetingWrite",
          manifest: yield* libraryManifestFromLocalStateEffect(competingState),
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
        inject({ _tag: "FailPublish", anchoredOnly: false });
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
        inject({ _tag: "FailPublish", anchoredOnly: false });
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
        inject({ _tag: "FailPublish", anchoredOnly: false });
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
        }
        const blockedRoot = join(device.home, "blocked-root");
        const expectedBytes = (yield* fs.exists(join(device.root, "first", "SKILL.md")))
          ? yield* fs.readFileString(join(device.root, "first", "SKILL.md"))
          : "first\n";
        inject({ _tag: "ObstructAfterPublish", home: device.home, path: blockedRoot });
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
        inject({ _tag: "FailPublish", anchoredOnly: false });
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

it.effect(
  "fresh-device sync reports completed transfers after the plan and before restoration",
  () =>
    Effect.gen(function* () {
      const { a, b } = yield* devices;
      yield* a.retain("first");
      yield* a.retain("second");
      yield* a.sync();
      const events: string[] = [];
      const result = yield* b.sync({
        onPlan: () =>
          Effect.sync(() => {
            events.push("plan");
          }),
        onProgress: (message) =>
          Effect.sync(() => {
            events.push(message);
          }),
      });
      assert.strictEqual(result.status, "pulled");
      assert.deepStrictEqual(
        events.filter((event) => event.startsWith("Downloading")),
        [
          "Downloading Skill copies · 0/2",
          "Downloading Skill copies · 1/2",
          "Downloading Skill copies · 2/2",
        ],
      );
      assert.ok(events.indexOf("plan") < events.indexOf("Downloading Skill copies · 0/2"));
      assert.ok(
        events.indexOf("Downloading Skill copies · 2/2") <
          events.indexOf("Restoring retained Skill copies"),
      );
      assert.strictEqual(events.at(-1), "Enabling synced Skills");
      assert.strictEqual((yield* b.state).collections.length, 2);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
