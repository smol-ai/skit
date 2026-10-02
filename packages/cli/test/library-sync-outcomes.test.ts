import { assert, it } from "@effect/vitest";
import { Effect, Schema, type Layer, type Scope } from "effect";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  LibraryState,
  captureSnapshotArchiveEffect,
  retainedTreePath,
  libraryManifestFromLocalStateEffect,
  skitLayer,
} from "@smolai/skit-core";
import { LibraryChangedOnServer } from "../src/registry/failures.js";
import { SyncLocalChanged } from "../src/workflows/library/library-sync.js";
import { devices, untouched } from "./helpers/library-sync-devices.js";

type Homes = Effect.Success<typeof devices>;

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
  expectedFailure?: boolean;
  run: (
    homes: Homes,
  ) => Effect.Effect<void, unknown, Layer.Success<typeof skitLayer> | Scope.Scope>;
}[] = [
  {
    row: "Preflight: local_bytes_changed preserves every store",
    run: (homes) =>
      Effect.gen(function* () {
        const { a, server } = homes;
        yield* seed(homes);
        yield* a.corruptOriginal;
        const unchanged = yield* untouched(a);
        const before = server.stored;
        assert.strictEqual((yield* a.sync()).status, "local_bytes_changed");
        yield* unchanged;
        assert.deepStrictEqual(server.stored, before);
        // Run the real command; assert its exit status, never its rendered output.
        const result = spawnSync(
          process.execPath,
          [
            join(import.meta.dirname, "../bin/skit.js"),
            "sync",
            "--apply",
            "--home",
            a.home,
            "--json",
          ],
          {
            env: { ...process.env, SKIT_SERVER_URL: "https://registry.test", SKIT_TOKEN: "test" },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        assert.strictEqual(result.error, undefined);
        assert.strictEqual(JSON.parse(result.stdout).data.status, "local_bytes_changed");
        yield* unchanged;
        assert.deepStrictEqual(server.stored, before);
      }),
  },
  {
    row: "Preflight: local_bytes_changed requires a nonzero CLI exit",
    expectedFailure: true,
    run: (homes) =>
      Effect.gen(function* () {
        const { a } = homes;
        yield* seed(homes);
        yield* a.corruptOriginal;
        const result = spawnSync(
          process.execPath,
          [
            join(import.meta.dirname, "../bin/skit.js"),
            "sync",
            "--apply",
            "--home",
            a.home,
            "--json",
          ],
          {
            env: { ...process.env, SKIT_SERVER_URL: "https://registry.test", SKIT_TOKEN: "test" },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        assert.strictEqual(result.error, undefined);
        assert.strictEqual(JSON.parse(result.stdout).data.status, "local_bytes_changed");
        // The separate ordinary row above proves nonmutation without an expected-failure mask.
        assert.notStrictEqual(result.status, 0);
      }),
  },
  {
    row: "Preflight: legacy_remote_conflict",
    run: (homes) =>
      Effect.gen(function* () {
        const { a, faults, server } = homes;
        yield* seed(homes);
        faults.remoteManifest = { schema: "skit.library.v2", entries: [], bindings: [] };
        const unchanged = yield* untouched(a);
        const before = server.stored;
        assert.strictEqual((yield* a.sync()).status, "legacy_remote_conflict");
        yield* unchanged;
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
        const unchanged = yield* untouched(a);
        const before = server.stored;
        assert.strictEqual((yield* a.sync()).status, "base_mismatch");
        yield* unchanged;
        assert.deepStrictEqual(server.stored, before);
      }),
  },
  {
    row: "Push: before P2 (failed upload)",
    run: ({ a, faults, server }) =>
      Effect.gen(function* () {
        yield* a.retain("first");
        const unchanged = yield* untouched(a);
        faults.failNextUpload = true;
        yield* Effect.flip(a.sync());
        yield* unchanged;
        assert.strictEqual(server.remote, null);
        assert.strictEqual((yield* a.sync()).status, "pushed");
      }),
  },
  {
    row: "Push: P2 loses the CAS on the first push",
    run: ({ a, b, faults, server }) =>
      Effect.gen(function* () {
        yield* a.retain("from-a");
        yield* b.retain("from-b");
        // The competitor uploads its bytes and commits before A's null-base CAS.
        const competingState = yield* b.state;
        const archive = yield* captureSnapshotArchiveEffect(
          retainedTreePath(join(b.home, "originals"), competingState.retained_copies[0]!.digest),
        );
        assert.strictEqual(server.respond("POST", "/api/library/snapshots", archive).status, 200);
        faults.competingWrite = yield* libraryManifestFromLocalStateEffect(competingState);
        const unchanged = yield* untouched(a);
        assert.instanceOf(yield* Effect.flip(a.sync()), LibraryChangedOnServer);
        yield* unchanged;
        const winner = server.remote;
        assert.ok(winner);
        assert.strictEqual((yield* a.sync()).status, "adoption_required");
        yield* unchanged;
        assert.deepStrictEqual(server.remote, winner);
        assert.strictEqual((yield* a.sync({ adopt: true })).status, "merged");
        assert.strictEqual((yield* a.state).collections.length, 2);
      }),
  },
  {
    row: "Push: P2 response lost before P4",
    run: ({ a, faults, server }) =>
      Effect.gen(function* () {
        yield* a.retain("first");
        const unchanged = yield* untouched(a);
        faults.loseNextWriteResponse = true;
        yield* Effect.flip(a.sync());
        yield* unchanged;
        const committed = server.remote;
        assert.ok(committed);
        assert.strictEqual((yield* a.sync()).status, "clean");
        assert.deepStrictEqual(server.remote, committed);
        assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, committed.revision_id);
      }),
  },
  {
    row: "Push: after P2 before P4 (failed local publish)",
    run: ({ a, faults, server }) =>
      Effect.gen(function* () {
        yield* a.retain("first");
        const unchanged = yield* untouched(a);
        faults.failNextLocalPublish = true;
        yield* Effect.flip(a.sync());
        yield* unchanged;
        assert.ok(server.remote);
        assert.strictEqual((yield* a.sync()).status, "clean");
        assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, server.remote!.revision_id);
      }),
  },
  {
    row: "Push: P2 response lost, then another home writes before retry",
    run: ({ a, b, faults, server }) =>
      Effect.gen(function* () {
        yield* a.retain("first");
        const unchanged = yield* untouched(a);
        faults.loseNextWriteResponse = true;
        yield* Effect.flip(a.sync());
        yield* unchanged;
        yield* b.sync();
        yield* b.retain("second");
        yield* b.sync();
        const winner = server.remote;
        assert.strictEqual((yield* a.sync()).status, "adoption_required");
        yield* unchanged;
        assert.deepStrictEqual(server.remote, winner);
        assert.strictEqual((yield* a.sync({ adopt: true })).status, "merged");
        assert.strictEqual((yield* a.state).collections.length, 2);
        assert.strictEqual((yield* b.sync()).status, "clean");
      }),
  },
  {
    row: "Pull: before U4 (failed local publish)",
    run: ({ a, b, faults, server }) =>
      Effect.gen(function* () {
        yield* a.retain("first");
        yield* a.sync();
        const unchanged = yield* untouched(b);
        const head = server.remote;
        faults.failNextLocalPublish = true;
        yield* Effect.flip(b.sync());
        yield* unchanged;
        assert.deepStrictEqual(server.remote, head);
        assert.strictEqual((yield* b.sync()).status, "pulled");
        assert.strictEqual((yield* b.state).sync_ancestry?.revision_id, head!.revision_id);
      }),
  },
  {
    row: "Pull: U3 finds a concurrent local write (SyncLocalChanged)",
    run: ({ fs, a, b, c, faults, server }) =>
      Effect.gen(function* () {
        yield* a.retain("remote");
        yield* a.sync();
        yield* c.retain("concurrent-local");
        const concurrent = yield* c.state;
        yield* fs.makeDirectory(b.home, { recursive: true });
        yield* fs.copy(join(c.home, "originals"), join(b.home, "originals"));
        faults.changeBeforeReinspect = { home: b.home, state: concurrent };
        const head = server.remote;
        assert.ok(Schema.is(SyncLocalChanged)(yield* Effect.flip(b.sync())));
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
        const { fs, a, b, faults, server } = homes;
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
        faults.changeBeforeReinspect = { home: a.home, state: concurrent };
        const markerBefore = yield* fs.readFile(join(a.root, "first", ".skit-ownership.json"));
        const skillBefore = yield* fs.readFile(join(a.root, "first", "SKILL.md"));
        const head = server.remote;
        assert.ok(Schema.is(SyncLocalChanged)(yield* Effect.flip(a.sync())));
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
        const { a, b, faults, server } = homes;
        yield* seed(homes);
        yield* a.retain("from-a");
        yield* b.retain("from-b");
        yield* b.sync();
        faults.competingWrite = {
          ...server.remote!.manifest,
          collections: server.remote!.manifest.collections.map((item) => ({
            ...item,
            label: "competing",
          })),
        };
        const unchanged = yield* untouched(a);
        assert.instanceOf(yield* Effect.flip(a.sync()), LibraryChangedOnServer);
        yield* unchanged;
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
        const { a, b, faults, server } = homes;
        yield* seed(homes);
        yield* a.retain("from-a");
        yield* b.retain("from-b");
        yield* b.sync();
        const unchanged = yield* untouched(a);
        faults.failNextLocalPublish = true;
        yield* Effect.flip(a.sync());
        yield* unchanged;
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
        const { a, b, faults, server } = homes;
        yield* seed(homes);
        yield* a.retain("from-a");
        yield* b.retain("from-b");
        yield* b.sync();
        const unchanged = yield* untouched(a);
        const head = server.remote;
        faults.failNextUpload = true;
        yield* Effect.flip(a.sync());
        yield* unchanged;
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
        const unchanged = yield* untouched(b);
        const before = server.stored;
        assert.strictEqual((yield* b.sync()).status, "adoption_required");
        yield* unchanged;
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
        const unchanged = yield* untouched(a);
        const before = server.stored;
        const value = yield* a.sync(
          outcome === "merge_ready"
            ? { apply: false }
            : outcome === "resolution_invalid"
              ? { takeRemote: ["collection:not-a-conflict"] }
              : {},
        );
        assert.strictEqual(value.status, outcome);
        yield* unchanged;
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
        const { fs, a, b, faults, server } = homes;
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
        faults.blockProjectionAfterPublish = { home: device.home, path: blockedRoot };
        yield* Effect.exit(
          device.sync({ rootFor: (target) => (target === "agents" ? blockedRoot : undefined) }),
        );
        const published = yield* device.state;
        assert.ok(published.sync_ancestry);
        assert.strictEqual(published.sync_ancestry.revision_id, server.remote!.revision_id);
        assert.strictEqual(published.collections.length, row.startsWith("Merge") ? 2 : 1);
        yield* fs.remove(blockedRoot);
        assert.strictEqual((yield* device.sync()).status, "clean");
        assert.isTrue(yield* fs.exists(join(device.root, "first", "SKILL.md")));
      }),
  })),
  {
    row: "Merge: after M5 before M7 (--take-remote must be repeated)",
    run: (homes) =>
      Effect.gen(function* () {
        const { a, b, faults, server } = homes;
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
        const unchanged = yield* untouched(a);
        faults.failNextLocalPublish = true;
        yield* Effect.flip(a.sync({ takeRemote: [`collection:${id}`] }));
        yield* unchanged;
        const committed = server.remote!;
        assert.strictEqual((yield* a.sync()).status, "conflicted");
        yield* unchanged;
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
  (scenario.expectedFailure ? it.effect.fails : it.effect)(`oracle row: ${scenario.row}`, () =>
    Effect.gen(function* () {
      yield* scenario.run(yield* devices);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
