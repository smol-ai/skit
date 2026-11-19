import { describe } from "@effect/vitest";
import { emptyLibraryFixture } from "./helpers/library-home.js";
import { readLibraryManifest } from "./helpers/library-manifest.js";
import { originalArchive, originalTreePath } from "./helpers/original-tree.js";
import * as Library from "@smolai/skit-core/library";
import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Effect, Option, Exit, type Layer, type Scope } from "effect";
import type { SkillId } from "@smolai/skit-core/universal/consumer";
import { join } from "node:path";
import { LibraryState } from "@smolai/skit-core/library";
import { deterministicTreeHash } from "@smolai/skit-core/author";
import { LibraryApiRejected, LibraryManifestTooNew } from "../src/library/sync/api.js";
import { SyncLocalChanged } from "@smolai/skit-core/library/sync";
import {
  assertDiskUnchanged,
  captureDisk,
  diskChanges,
  noDiskChanges,
} from "./helpers/disk-snapshot.js";
import { devices } from "./helpers/library-sync-devices.js";
import { testRoots } from "./helpers/roots.js";

type Homes = Effect.Success<typeof devices>;

for (const restart of [false, true])
  it.effect(
    `Sync keeps later remote removals and enabled choices after ${restart ? "a later run" : "a CAS retry"}`,
    () =>
      Effect.gen(function* () {
        const { a, b, c, inject, server } = yield* devices;
        const shared = yield* c.importSource("shared");
        const skill = shared.skills[0];
        assert.ok(skill);
        yield* c.edit((state) => ({ ...state, enabled: [{ skill: skill.skill_id }] }));
        yield* c.sync();
        yield* a.sync();
        const local = yield* a.importSource("local-only");
        const added = yield* c.importSource("remote-added");
        yield* c.edit((state) => ({ ...state, enabled: [] }));
        yield* c.sync();
        const mergedHead = server.remote;
        assert.ok(mergedHead);
        yield* b.sync();
        yield* b.remove(added.collection.collection_id);
        yield* b.edit((state) => ({ ...state, enabled: [{ skill: skill.skill_id }] }));
        const newer = yield* readLibraryManifest(b.home, b.disk);
        inject({ _tag: "CompetingWrite", manifest: newer });
        if (restart) {
          let interrupted = false;
          const failure = yield* Effect.flip(
            a.sync({
              progress: {
                tick: () => Effect.void,
                around: (phase, operation) =>
                  Effect.gen(function* () {
                    if (phase.kind === "save-remote" && !interrupted) {
                      interrupted = true;
                      // The CAS loses, and the response to the following read is unusable. A later
                      // owner must recover the incorporated head from disk, not from retry memory.
                      inject({ _tag: "ServeHead", body: null });
                    }
                    return yield* operation;
                  }),
              },
            }),
          );
          assert.strictEqual(failure._tag, "LibraryChangedOnServer");
          const staged = yield* a.state;
          assert.strictEqual(staged.sync_ancestry?.revision_id, mergedHead.revision_id);
          assert.deepStrictEqual(staged.sync_ancestry?.base_manifest, mergedHead.manifest);
        }
        const outcome = yield* a.sync();
        assert.strictEqual(outcome.status, "merged");
        const state = yield* a.state;
        assert.isFalse(
          state.collections.some((row) => row.collection_id === added.collection.collection_id),
        );
        assert.isTrue(
          state.collections.some((row) => row.collection_id === local.collection.collection_id),
        );
        assert.deepStrictEqual(state.enabled, [{ skill: skill.skill_id }]);
        assert.deepStrictEqual(server.remote?.manifest.enabled, [{ skill: skill.skill_id }]);
        assert.isFalse(
          server.remote?.manifest.collections.some(
            (row) => row.collection_id === added.collection.collection_id,
          ),
        );
      }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );

/** Failed work may add exact orphan content, while domain state, history and user files stay put. */
const onlyOrphanOriginals = Effect.fn("Test.onlyOrphanOriginals")(function* (device: Homes["a"]) {
  const owner = yield* device.owner();
  const state = yield* owner.read;
  const history = yield* owner.history;
  const database = yield* captureDisk([join(device.home, "library.sqlite")]);
  const originals = yield* captureDisk([join(device.home, "originals")]);
  const files = yield* captureDisk([
    device.root,
    join(device.home, "variants"),
    join(device.home, "removed"),
    join(device.home, "machine.json"),
  ]);
  return {
    check: Effect.gen(function* () {
      assert.deepStrictEqual(yield* owner.read, state);
      assert.deepStrictEqual(yield* owner.history, history);
      if (state._tag === "Present") yield* assertDiskUnchanged(database);
      yield* assertDiskUnchanged(files);
      const changes = yield* diskChanges(originals);
      assert.deepStrictEqual(changes.changed, []);
      assert.deepStrictEqual(changes.deleted, []);
      for (const { path } of changes.created)
        assert.strictEqual(path[0], join(device.home, "originals"));
    }),
  };
});

/** A current state with nothing installed, written as the v7 document an older SKIT left. */
const asV7 = ({
  schemaVersion: _schemaVersion,
  collection_versions,
  imports,
  enabled,
  invocation_policies,
  repositories,
  installed_skills,
  skills,
  ...fields
}: LibraryState) => {
  assert.deepStrictEqual([repositories, installed_skills], [[], []]);
  return {
    ...fields,
    schemaVersion: 7,
    skills: skills.map(({ versions, ...skill }) => ({
      ...skill,
      versions: versions.map(
        ({ source_hash, artifact_hash, validation_identity_hash, ...version }) => ({
          ...version,
          source_digest: source_hash,
          artifact_digest: artifact_hash,
          validation_identity_digest: validation_identity_hash,
        }),
      ),
    })),
    retained_copies: collection_versions.map(
      ({ collection_version_id, hash, members, ...copy }) => ({
        ...copy,
        retained_copy_id: collection_version_id,
        digest: hash,
        members: members.map(({ source_hash, artifact_hash, ...member }) => ({
          ...member,
          source_digest: source_hash,
          artifact_digest: artifact_hash,
        })),
      }),
    ),
    acquisitions: imports.map(
      ({ import_id, kind, collection_version_id, imported_at, lock_file_entries, ...item }) => ({
        ...item,
        acquisition_id: import_id,
        kind: kind === "edit" ? "retained-edit" : kind,
        retained_copy_id: collection_version_id,
        acquired_at: imported_at,
        observations: lock_file_entries.map(
          ({ read_at, original_entry_hash, well_known_hash, ...entry }) => ({
            ...entry,
            observed_at: read_at,
            original_entry_digest: original_entry_hash,
            ...(well_known_hash === undefined ? {} : { well_known_digest: well_known_hash }),
          }),
        ),
      }),
    ),
    global_bindings: enabled.length
      ? [
          {
            scope: { kind: "global" },
            entries: enabled.map((item) =>
              "skill" in item
                ? { kind: "skill", skill_id: item.skill }
                : { kind: "collection", collection_id: item.collection },
            ),
            ...(invocation_policies === undefined ? {} : { invocation_policies }),
          },
        ]
      : [],
    local_bindings: [],
    projections: [],
  };
};

const seed = Effect.fn("Test.seedSyncHomes")(function* ({ a, b }: Homes) {
  yield* a.importSource("first");
  yield* a.edit((state) => ({
    ...state,
    enabled: [{ skill: state.skills[0]!.skill_id }],
    invocation_policies: { [state.skills[0]!.skill_id]: "explicit" },
  }));
  yield* a.project();
  yield* a.sync();
  yield* b.sync();
});

const cases = [
  {
    row: "Preflight: local_bytes_changed preserves every store",
    run: (homes) =>
      Effect.gen(function* () {
        const { a, server } = homes;
        yield* seed(homes);
        yield* a.corruptOriginal;
        const unchanged = yield* a.unchanged;
        const before = server.stored;
        assert.strictEqual((yield* a.sync()).status, "local_bytes_changed");
        yield* unchanged.check;
        assert.deepStrictEqual(server.stored, before);
      }),
  },
  {
    row: "Different Library: preview merges from an empty base",
    run: (homes) =>
      Effect.gen(function* () {
        const { a, resetRemote, server } = homes;
        yield* seed(homes);
        yield* resetRemote;
        const unchanged = yield* a.unchanged;
        const before = server.stored;
        assert.strictEqual((yield* a.sync({ apply: false })).status, "push_ready");
        yield* unchanged.check;
        assert.deepStrictEqual(server.stored, before);
      }),
  },
  {
    row: "Push: before P2 (failed upload)",
    run: ({ a, inject, server }) =>
      Effect.gen(function* () {
        yield* a.importSource("first");
        const before = yield* a.state;
        inject({ _tag: "FailUpload" });
        assert.ok((yield* Effect.flip(a.sync())) instanceof LibraryApiRejected);
        assert.deepStrictEqual(yield* a.state, before);
        assert.strictEqual(server.remote, null);
        assert.strictEqual((yield* a.sync()).status, "pushed");
      }),
  },
  {
    row: "Push: P2 loses the CAS on the first push",
    run: ({ a, b, inject, server }) =>
      Effect.gen(function* () {
        yield* a.importSource("from-a");
        yield* b.importSource("from-b");
        // The competitor uploads its bytes and commits before A's null-base CAS.
        const competingState = yield* b.state;
        const archive = yield* originalArchive(
          originalTreePath(join(b.home, "originals"), competingState.collection_versions[0]!.hash),
          competingState.collection_versions[0]!.hash,
        );
        assert.strictEqual(server.respond("POST", "/api/library/snapshots", archive).status, 200);
        inject({
          _tag: "CompetingWrite",
          manifest: yield* readLibraryManifest(b.home, b.disk),
        });
        assert.strictEqual((yield* a.sync()).status, "merged");
        assert.strictEqual((yield* a.state).collections.length, 2);
        assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, server.remote?.revision_id);
      }),
  },
  {
    row: "Push: refused locally before sending, then local enabled intent changes",
    run: ({ a, inject, server }) =>
      Effect.gen(function* () {
        const imported = yield* a.importSource("first");
        const skill = imported.skills[0]!;
        inject({ _tag: "FailSave", anchoredOnly: false });
        assert.strictEqual(
          (yield* Effect.flip(a.sync({ deviceSelection: "follow-account" })))._tag,
          "PlatformError",
        );
        const accepted = server.remote;
        assert.isNull(accepted);
        assert.isUndefined((yield* a.state).sync_ancestry);
        yield* a.edit((state) => ({ ...state, enabled: [{ skill: skill.skill_id }] }));
        const changed = yield* a.state;
        const before = yield* a.unchanged;
        const preview = yield* a.sync({ apply: false });
        assert.strictEqual(preview.status, "push_ready");
        yield* before.check;
        assert.deepStrictEqual(server.remote, accepted);
        const applied = yield* a.sync();
        assert.strictEqual(applied.status, "pushed");
        const after = yield* a.state;
        assert.deepStrictEqual(after.enabled, changed.enabled);
        assert.deepStrictEqual(after.collections, changed.collections);
        assert.strictEqual(after.sync_ancestry?.revision_id, server.remote?.revision_id);
        assert.deepStrictEqual(after.sync_ancestry?.base_manifest.enabled, changed.enabled);
        const writes = server.writes;
        assert.strictEqual((yield* a.sync()).status, "clean");
        assert.strictEqual((yield* a.sync()).status, "clean");
        assert.strictEqual(server.writes, writes);
      }),
  },
  {
    row: "Push: collision choice survives refused publication with subsequent compatible edits",
    run: ({ a, inject, server }) =>
      Effect.gen(function* () {
        const first = yield* a.importSource("first", { name: "review" });
        const second = yield* a.importSource("second", { name: "review" });
        const third = yield* a.importSource("third");
        const firstId = first.skills[0]!.skill_id;
        const secondId = second.skills[0]!.skill_id;
        const thirdId = third.skills[0]!.skill_id;
        yield* a.edit((state) => ({
          ...state,
          enabled: [{ skill: firstId }, { skill: secondId }],
        }));
        inject({ _tag: "FailSave", anchoredOnly: false });
        assert.strictEqual(
          (yield* Effect.flip(a.sync({ keepEnabled: [firstId] })))._tag,
          "PlatformError",
        );
        assert.isNull(server.remote);
        assert.isUndefined((yield* a.state).sync_ancestry);
        yield* a.edit((state) => ({ ...state, enabled: [...state.enabled, { skill: thirdId }] }));
        const before = yield* a.unchanged;
        const head = server.remote;
        assert.strictEqual((yield* a.sync()).status, "conflicted");
        const preview = yield* a.sync({ apply: false, keepEnabled: [firstId] });
        assert.strictEqual(preview.status, "push_ready");
        yield* before.check;
        assert.deepStrictEqual(server.remote, head);
        assert.strictEqual((yield* a.sync({ keepEnabled: [firstId] })).status, "pushed");
        const after = yield* a.state;
        assert.sameDeepMembers(after.enabled, [{ skill: firstId }, { skill: thirdId }]);
        assert.strictEqual(after.skills.length, 3);
        assert.deepStrictEqual(
          after.enabled,
          (yield* Effect.sync(() => server.remote))?.manifest.enabled,
        );
        assert.strictEqual((yield* a.sync()).status, "clean");
        assert.strictEqual((yield* a.sync()).status, "clean");
      }),
  },
  {
    row: "Push: HTTP 500 after commit is verified by reading the head",
    run: ({ a, inject, server }) =>
      Effect.gen(function* () {
        yield* a.importSource("first");
        inject({ _tag: "ErrorAfterCommit" });
        assert.strictEqual((yield* a.sync()).status, "pushed");
        assert.ok(server.remote);
        assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, server.remote.revision_id);
        assert.strictEqual((yield* a.sync()).status, "clean");
      }),
  },
  {
    row: "Push: P2 response lost before P4",
    run: ({ a, inject, server }) =>
      Effect.gen(function* () {
        yield* a.importSource("first");
        inject({ _tag: "DropAfterCommit" });
        assert.strictEqual((yield* a.sync()).status, "pushed");
        const committed = server.remote;
        assert.ok(committed);
        assert.strictEqual((yield* a.sync()).status, "clean");
        assert.deepStrictEqual(server.remote, committed);
        assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, committed.revision_id);
      }),
  },
  {
    row: "Push: a changed device choice is refused before remote write",
    run: ({ a, inject, server }) =>
      Effect.gen(function* () {
        yield* a.importSource("first");
        const unchanged = yield* a.unchanged;
        inject({ _tag: "FailSave", anchoredOnly: false });
        assert.strictEqual(
          (yield* Effect.flip(a.sync({ deviceSelection: "follow-account" })))._tag,
          "PlatformError",
        );
        yield* unchanged.check;
        assert.isNull(server.remote);
        assert.strictEqual((yield* a.sync()).status, "pushed");
        assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, server.remote!.revision_id);
      }),
  },
  {
    row: "Push: lost response is verified before another home writes",
    run: ({ a, b, inject, server }) =>
      Effect.gen(function* () {
        yield* a.importSource("first");
        inject({ _tag: "DropAfterCommit" });
        assert.strictEqual((yield* a.sync()).status, "pushed");
        yield* b.sync();
        yield* b.importSource("second");
        yield* b.sync();
        const winner = server.remote;
        const unchanged = yield* a.unchanged;
        assert.strictEqual((yield* a.sync({ apply: false })).status, "merge_ready");
        yield* unchanged.check;
        assert.deepStrictEqual(server.remote, winner);
        assert.strictEqual((yield* a.sync()).status, "merged");
        assert.strictEqual((yield* a.state).collections.length, 2);
        assert.strictEqual((yield* b.sync()).status, "clean");
      }),
  },
  {
    row: "Pull: before U4 (failed local publish)",
    run: ({ a, b, inject, server }) =>
      Effect.gen(function* () {
        yield* a.importSource("first");
        yield* a.sync();
        const unchanged = yield* onlyOrphanOriginals(b);
        const head = server.remote;
        inject({ _tag: "FailSave", anchoredOnly: false });
        assert.strictEqual((yield* Effect.flip(b.sync()))._tag, "PlatformError");
        yield* unchanged.check;
        assert.deepStrictEqual(server.remote, head);
        assert.strictEqual((yield* b.sync()).status, "pulled");
        assert.strictEqual((yield* b.state).sync_ancestry?.revision_id, head!.revision_id);
      }),
  },
  {
    row: "Pull: U3 finds a concurrent local write (SyncLocalChanged)",
    run: ({ fs, a, b, c, inject, server }) =>
      Effect.gen(function* () {
        yield* a.importSource("remote");
        yield* a.sync();
        yield* c.importSource("concurrent-local");
        yield* fs.makeDirectory(b.home, { recursive: true });
        yield* fs.copy(join(c.home, "originals"), join(b.home, "originals"));
        inject({
          _tag: "ChangeStateWhenHeadRead",
          home: b.home,
          change: (yield* b.owner()).inventory.refresh,
        });
        const head = server.remote;
        assert.ok((yield* Effect.flip(b.sync())) instanceof SyncLocalChanged);
        assert.deepStrictEqual((yield* b.state).ownershipIssues, []);
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
        yield* b.importSource("remote-addition");
        yield* b.sync();
        inject({
          _tag: "ChangeStateWhenHeadRead",
          home: a.home,
          change: (yield* a.owner()).inventory.refresh,
        });
        const markerBefore = yield* fs.readFile(join(a.root, "first", ".skit-ownership.json"));
        const skillBefore = yield* fs.readFile(join(a.root, "first", "SKILL.md"));
        const head = server.remote;
        assert.ok((yield* Effect.flip(a.sync())) instanceof SyncLocalChanged);
        assert.deepStrictEqual((yield* a.state).ownershipIssues, []);
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
        yield* b.importSource("remote-addition");
        yield* b.sync();
        yield* a.importSource("local-addition");
        let concurrent: Library.Snapshot | undefined;
        const writer = yield* a.owner();
        inject({
          _tag: "ChangeStateWhenHeadRead",
          home: a.home,
          change: Effect.gen(function* () {
            const inventory = yield* writer.inventory.refresh;
            concurrent = yield* writer.read;
            return inventory;
          }),
        });
        const head = server.remote;
        events.length = 0;
        assert.instanceOf(yield* Effect.flip(a.sync()), SyncLocalChanged);
        assert.deepStrictEqual(events, ["save a"]);
        assert.deepStrictEqual(yield* writer.read, concurrent);
        assert.deepStrictEqual(server.remote, head);
      }),
  },
  {
    row: "Pull: U3 stops before writing a --keep-enabled choice",
    run: ({ fs, a, b, c, events, inject, server }) =>
      Effect.gen(function* () {
        const first = yield* a.importSource("first", { name: "review" });
        const second = yield* a.importSource("second", { name: "review" });
        yield* a.edit((state) => ({
          ...state,
          enabled: [first, second].map((item) => ({ skill: item.skills[0]!.skill_id })),
        }));
        // A device that installs nothing has no collision, so the Library can be pushed as it is.
        yield* a.sync({ deviceSelection: { skills: [], collections: [] } });
        yield* c.importSource("concurrent-local");
        yield* fs.makeDirectory(b.home, { recursive: true });
        yield* fs.copy(join(c.home, "originals"), join(b.home, "originals"));
        let concurrent: Library.Snapshot | undefined;
        const writer = yield* b.owner();
        inject({
          _tag: "ChangeStateWhenHeadRead",
          home: b.home,
          change: Effect.gen(function* () {
            const inventory = yield* writer.inventory.refresh;
            concurrent = yield* writer.read;
            return inventory;
          }),
        });
        const head = server.remote;
        events.length = 0;
        assert.instanceOf(
          yield* Effect.flip(b.sync({ keepEnabled: [first.skills[0]!.skill_id] })),
          SyncLocalChanged,
        );
        assert.deepStrictEqual(events, ["save b"]);
        assert.deepStrictEqual(yield* writer.read, concurrent);
        assert.deepStrictEqual(server.remote, head);
      }),
  },
  {
    row: "Merge: a lost CAS merges the changed head from the incorporated head",
    run: (homes) =>
      Effect.gen(function* () {
        const { a, b, inject, server } = homes;
        yield* seed(homes);
        yield* a.importSource("from-a");
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
        let sends = 0;
        assert.strictEqual(
          (yield* a.sync({
            progress: {
              tick: () => Effect.void,
              around: (phase, work) =>
                Effect.gen(function* () {
                  if (phase.kind === "save-remote") {
                    sends++;
                    const incorporated = (yield* a.state.pipe(Effect.orDie)).sync_ancestry;
                    assert.ok(server.remote);
                    assert.strictEqual(incorporated?.revision_id, server.remote.revision_id);
                    assert.deepStrictEqual(incorporated?.base_manifest, server.remote.manifest);
                  }
                  return yield* work;
                }),
            },
          })).status,
          "merged",
        );
        assert.strictEqual(sends, 2);
        assert.strictEqual((yield* a.state).collections.length, 2);
        assert.strictEqual((yield* a.state).collections[0]?.label, "competing");
        assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, server.remote?.revision_id);
        assert.deepStrictEqual((yield* a.state).invocation_policies, {
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
        yield* a.importSource("from-a");
        yield* b.importSource("from-b");
        yield* b.sync();
        const unchanged = yield* onlyOrphanOriginals(a);
        inject({ _tag: "FailSave", anchoredOnly: false });
        assert.strictEqual((yield* Effect.flip(a.sync()))._tag, "PlatformError");
        yield* unchanged.check;
        const committed = server.remote!;
        assert.strictEqual(committed.manifest.collections.length, 2);
        assert.strictEqual((yield* a.sync()).status, "merged");
        assert.strictEqual(server.remote?.manifest.collections.length, 3);
        assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, server.remote?.revision_id);
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
        yield* a.importSource("from-a");
        yield* b.importSource("from-b");
        yield* b.sync();
        const head = server.remote;
        assert.ok(head);
        inject({ _tag: "FailUpload" });
        assert.ok((yield* Effect.flip(a.sync())) instanceof LibraryApiRejected);
        assert.strictEqual((yield* a.state).sync_ancestry?.revision_id, head.revision_id);
        assert.deepStrictEqual((yield* a.state).sync_ancestry?.base_manifest, head.manifest);
        assert.strictEqual((yield* a.state).collections.length, 3);
        assert.deepStrictEqual(server.remote, head);
        assert.strictEqual((yield* a.sync()).status, "merged");
        assert.strictEqual((yield* a.state).collections.length, 3);
      }),
  },
  {
    row: "First connection: add-only preview writes nothing",
    run: ({ a, b, server }) =>
      Effect.gen(function* () {
        yield* a.importSource("remote");
        yield* a.sync();
        yield* b.importSource("local");
        const unchanged = yield* b.unchanged;
        const before = server.stored;
        assert.strictEqual((yield* b.sync({ apply: false })).status, "merge_ready");
        yield* unchanged.check;
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
        } else yield* b.importSource("remote-addition");
        yield* b.sync();
        const unchanged = yield* a.unchanged;
        const before = server.stored;
        const value = yield* a.sync(
          outcome === "merge_ready"
            ? { apply: false }
            : outcome === "resolution_invalid"
              ? { takeRemote: ["collection:not-a-conflict"] }
              : {},
        );
        assert.strictEqual(value.status, outcome);
        yield* unchanged.check;
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
          yield* a.importSource("first");
          yield* a.edit((state) => ({
            ...state,
            enabled: [{ skill: state.skills[0]!.skill_id }],
          }));
        } else {
          if (row.startsWith("Clean")) {
            yield* a.importSource("first");
            yield* a.edit((state) => ({
              ...state,
              enabled: [{ skill: state.skills[0]!.skill_id }],
            }));
            yield* a.project();
            const backup = join(a.home, "..", "before-anchor");
            yield* fs.copy(a.home, backup);
            yield* a.sync();
            yield* fs.remove(a.home, { recursive: true });
            yield* fs.copy(backup, a.home);
          } else yield* seed(homes);
          if (row.startsWith("Pull")) device = homes.c;
          else if (row.startsWith("Merge")) {
            yield* b.importSource("remote-addition");
            yield* b.sync();
          }
        }
        const blockedRoot = join(device.home, "blocked-root");
        const expectedBytes = (yield* fs.exists(join(device.root, "first", "SKILL.md")))
          ? yield* fs.readFileString(join(device.root, "first", "SKILL.md"))
          : "first\n";
        const oldBase = (yield* device.state).sync_ancestry;
        const remoteBefore = server.remote;
        inject({ _tag: "ObstructAfterSave", home: device.home, path: blockedRoot });
        const first = yield* Effect.exit(
          device.sync({ rootFor: (target) => (target === "agents" ? blockedRoot : undefined) }),
        );
        assert.isTrue(Exit.isFailure(first));
        const published = yield* device.state;
        if (remoteBefore !== null) {
          assert.strictEqual(published.sync_ancestry?.revision_id, remoteBefore.revision_id);
          assert.deepStrictEqual(published.sync_ancestry?.base_manifest, remoteBefore.manifest);
        } else assert.deepStrictEqual(published.sync_ancestry, oldBase);
        assert.deepStrictEqual(server.remote, remoteBefore);
        assert.strictEqual(published.collections.length, row.startsWith("Merge") ? 2 : 1);
        yield* fs.remove(blockedRoot);
        assert.strictEqual(
          (yield* device.sync({
            rootFor: (target) => (target === "agents" ? blockedRoot : undefined),
          })).status,
          row.startsWith("Push") ? "pushed" : "clean",
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
        const first = yield* a.importSource("first");
        const second = yield* a.importSource("second");
        const enable = (ids: readonly SkillId[]) => (state: LibraryState) => ({
          ...state,
          enabled: ids.map((skill) => ({ skill })),
        });
        yield* a.edit(enable([first.skills[0]!.skill_id, second.skills[0]!.skill_id]));
        const owner = yield* a.owner();
        const initial = yield* owner.plan(
          { _tag: "Install", skills: [first.skills[0]!.skill_id] },
          { base: yield* owner.read },
        );
        yield* owner.apply({ _tag: "Apply", plan: initial });
        const update = { bytes: "first v2\n", importedAt: "2026-01-02T00:00:00.000Z" };
        if (path === "Merge") {
          yield* a.sync();
          yield* b.sync();
          yield* b.importSource("first", update);
          yield* b.sync();
        } else yield* a.importSource("first", update);
        const secondCopy = (yield* a.state).installed_skills.find(
          (copy) => copy.skill_id === second.skills[0]!.skill_id,
        );
        if (secondCopy !== undefined) {
          const local = yield* a.owner();
          const removal = yield* local.plan(
            {
              _tag: "Uninstall",
              copies: [secondCopy.installed_skill_id],
              drop: [secondCopy.installed_skill_id],
            },
            { base: yield* local.read },
          );
          yield* local.apply({ _tag: "Apply", plan: removal });
        }
        // An edit the selected Version would replace, and a Skill reconciliation must newly install.
        const installedSkill = (yield* a.state).installed_skills[0]!;
        yield* fs.writeFileString(join(installedSkill.path, "SKILL.md"), "unretained edit\n");
        inject({ _tag: "ObstructAfterSave", home: a.home, path: join(a.root, "second") });
        assert.isTrue(Exit.isFailure(yield* Effect.exit(a.sync())));
        const currentHash = yield* deterministicTreeHash(installedSkill.path);
        const recorded = (yield* a.state).installed_skills.find(
          (item) => item.installed_skill_id === installedSkill.installed_skill_id,
        );
        assert.deepStrictEqual(
          recorded?.status === "conflicted" ? recorded.current_hash : recorded?.status,
          currentHash,
        );
        yield* fs.remove(join(a.root, "second"));
        assert.strictEqual((yield* a.sync()).status, path === "Push" ? "pushed" : "clean");
        assert.strictEqual(
          yield* fs.readFileString(join(installedSkill.path, "SKILL.md")),
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
        yield* a.importSource("local-only");
        const unchanged = yield* a.unchanged;
        inject({ _tag: "FailSave", anchoredOnly: false });
        assert.strictEqual(
          (yield* Effect.flip(a.sync({ takeRemote: [`collection:${id}`] })))._tag,
          "PlatformError",
        );
        yield* unchanged.check;
        const committed = server.remote!;
        assert.strictEqual((yield* a.sync()).status, "conflicted");
        yield* unchanged.check;
        assert.deepStrictEqual(server.remote, committed);
        assert.strictEqual((yield* a.sync({ takeRemote: [`collection:${id}`] })).status, "merged");
        assert.strictEqual(server.remote?.manifest.collections.length, 2);
        assert.strictEqual(
          (yield* a.state).collections.find((item) => item.collection_id === id)!.label,
          "from-b",
        );
      }),
  },
] satisfies readonly {
  row: string;
  run: (
    homes: Homes,
  ) => Effect.Effect<void, unknown, Layer.Success<typeof testPlatformLayer> | Scope.Scope>;
}[];

/** Missing or renamed scenarios must fail registration instead of silently reducing coverage. */
const casesFor = (rows: readonly string[]) =>
  rows.map((row) => {
    const scenario = cases.find((item) => item.row === row);
    assert.ok(scenario, `Missing sync case: ${row}`);
    return scenario;
  });

// A `--take-remote` key names a merge conflict to take remotely. A push or a pull has none, so the
// key is refused before installed-skill collisions are checked, as it is on every other path.
it.effect("a --take-remote key is refused before collision checks on a push and a pull", () =>
  Effect.gen(function* () {
    const { fs, a, b, server } = yield* devices;
    const first = yield* a.importSource("first", { name: "review" });
    const second = yield* a.importSource("second", { name: "review" });
    yield* a.edit((state) => ({
      ...state,
      enabled: [first, second].map((item) => ({ skill: item.skills[0]!.skill_id })),
    }));
    const takeRemote = ["collection:not-a-conflict"];
    assert.strictEqual((yield* a.sync()).status, "conflicted");
    assert.deepStrictEqual(yield* a.sync({ takeRemote }), { status: "resolution_invalid" });
    assert.strictEqual(server.writeRequests, 0);
    // A device that installs nothing has no collision, so the Library can be pushed as it is.
    assert.strictEqual(
      (yield* a.sync({ deviceSelection: { skills: [], collections: [] } })).status,
      "pushed",
    );
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

it.effect(
  "fresh-device sync reports completed transfers after the plan and before restoration",
  () =>
    Effect.gen(function* () {
      const { a, b } = yield* devices;
      yield* a.importSource("first");
      yield* a.importSource("second");
      yield* a.sync();
      const events: string[] = [];
      const ticks: number[] = [];
      const result = yield* b.sync({
        onPlan: () =>
          Effect.sync(() => {
            events.push("plan");
          }),
        restoreProgress: {
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

/** Prepare through the owner; the resulting plan contains no writer callbacks. */
const prepareLocalSync = (home: string, roots: readonly string[]) =>
  Effect.gen(function* () {
    const library = yield* Library.Service;
    const base = yield* library.read;
    const state = base._tag === "Present" ? base.state : emptyLibraryFixture();
    const manifest = yield* readLibraryManifest(home, roots);
    const localArchives = base._tag === "Present" ? yield* library.content.pack(base) : [];
    const staged = yield* library.content.stage(manifest, {
      localArchives,
      registry: { origin: "https://registry.test", token: Option.none() },
    });
    const plan = yield* library.plan(
      {
        _tag: "Sync",
        staged,
        deviceSelection: Option.none(),
        pendingOrigin: Option.none(),
        acceptedBase: Option.fromUndefinedOr(state.sync_ancestry),
        remote: Option.none(),
      },
      { base },
    );
    if (Library.isRemoteSyncPlan(plan)) return yield* Effect.die("Expected local Sync review");
    return plan;
  });

it.effect("a Sync plan distinguishes an absent Library from a newly empty one", () =>
  Effect.gen(function* () {
    const { a } = yield* devices;
    const layer = Library.layer({ home: a.home, roots: testRoots(a.home) });
    const plan = yield* prepareLocalSync(a.home, a.disk).pipe(Effect.provide(layer));
    const owner = yield* a.owner();
    yield* owner.setup([], { base: yield* owner.read });
    const unchanged = yield* a.unchanged;
    const failure = yield* Effect.flip(
      Effect.flatMap(Library.Service, (library) => library.apply({ _tag: "Apply", plan })).pipe(
        Effect.provide(layer),
      ),
    );
    assert.strictEqual(failure._tag, "Library.StalePlan");
    yield* unchanged.check;
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a Sync plan cannot save into another Library home", () =>
  Effect.gen(function* () {
    const { a, b } = yield* devices;
    yield* a.importSource("first");
    const plan = yield* prepareLocalSync(a.home, a.disk).pipe(
      Effect.provide(Library.layer({ home: a.home, roots: testRoots(a.home) })),
    );
    const beforeA = yield* a.unchanged;
    const beforeB = yield* b.unchanged;
    const failure = yield* Effect.flip(
      Effect.flatMap(Library.Service, (library) => library.apply({ _tag: "Apply", plan })).pipe(
        Effect.provide(Library.layer({ home: b.home, roots: testRoots(b.home) })),
      ),
    );
    assert.strictEqual(failure._tag, "Library.StalePlan");
    yield* beforeA.check;
    yield* beforeB.check;
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("sync exposes bounded completed phases in transfer and save order", () =>
  Effect.gen(function* () {
    const { a, b } = yield* devices;
    yield* a.importSource("first");
    yield* a.importSource("second");
    const uploaded: number[] = [];
    yield* a.sync({
      progress: {
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
    const imported: number[] = [];
    const result = yield* b.sync({
      progress: {
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
      restoreProgress: {
        around: (phase, operation) =>
          operation.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed.push(phase.kind);
                if (phase.kind === "retain") imported.push(phase.total);
              }),
            ),
          ),
        tick: () => Effect.void,
      },
    });
    assert.strictEqual(result.status, "pulled");
    assert.deepStrictEqual(imported, [2]);
    assert.isBelow(completed.indexOf("download"), completed.indexOf("save-local"));
    // One owner call now completes both the publication and its installations.
    assert.strictEqual(completed.at(-1), "save-local");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

describe("skit sync", () => {
  describe("Connecting and previewing", () => {
    describe("Preview leaves the proposed Library sync unapplied.", () => {
      for (const scenario of casesFor([
        "Different Library: preview merges from an empty base",
        "First connection: add-only preview writes nothing",
        "Merge: merge_ready writes nothing",
      ]))
        it.effect(`oracle row: ${scenario.row}`, () =>
          Effect.gen(function* () {
            yield* scenario.run(yield* devices);
          }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
        );
    });
  });
});

describe("skit sync", () => {
  describe("Connecting and previewing", () => {
    describe("Sync refuses a newer Registry format before uploading changes.", () => {
      // A head another SKIT wrote in a newer manifest schema is refused before sync plans, uploads, writes
      // or saves anything. Only loader maintenance may touch the home: the writer lock creates an
      // absent home, and opening a legacy state.json migrates it and keeps the pre-migration file.
      for (const home of ["current", "legacy", "absent"] as const)
        for (const apply of [false, true])
          it.effect(
            `oracle row: Preflight: a newer remote manifest is refused (${home} home, ${apply ? "apply" : "preview"})`,
            () =>
              Effect.gen(function* () {
                const { fs, a: source, b, inject, server } = yield* devices;
                const a = home === "legacy" ? b : source;
                if (home !== "absent") {
                  yield* source.importSource("first");
                  // A pre-database fixture is imported only into a home that has never had a database.
                  if (home === "legacy") {
                    yield* fs.makeDirectory(a.home, { recursive: true });
                    yield* fs.copy(join(source.home, "originals"), join(a.home, "originals"));
                    yield* fs.writeFileString(
                      join(a.home, "state.json"),
                      JSON.stringify(asV7(yield* source.state)),
                    );
                  }
                }
                const before = yield* captureDisk(a.disk);
                const unchanged = home === "current" ? yield* a.unchanged : undefined;
                const stored = server.stored;
                const saves = a.saves;
                const writeRequests = server.writeRequests;
                inject({
                  _tag: "ServeHead",
                  body: JSON.parse(
                    yield* fs.readFileString(
                      join(
                        import.meta.dirname,
                        "../../skit/test/fixtures/library-wire/portable-v9.json",
                      ),
                    ),
                  ),
                });
                const failure = yield* Effect.flip(a.sync({ apply }));
                assert.instanceOf(failure, LibraryManifestTooNew);
                assert.strictEqual(failure.code, "VALIDATION_FAILED");
                // The legacy loader imports one domain state before preflight; Sync publishes none.
                assert.strictEqual(a.saves, saves + (home === "legacy" ? 1 : 0));
                // Snapshot uploads and Library writes are both write requests.
                assert.strictEqual(server.writeRequests, writeRequests);
                assert.deepStrictEqual(server.stored, stored);
                const changes = yield* diskChanges(before);
                const paths = (items: readonly { path: readonly string[] }[]) =>
                  items.map((item) => item.path.slice(1).join("/"));
                assert.deepStrictEqual(paths(changes.deleted), []);
                if (home === "current" && unchanged !== undefined) yield* unchanged.check;
                if (home === "absent") {
                  assert.deepStrictEqual(changes, noDiskChanges);
                }
                if (home === "legacy") {
                  assert.deepStrictEqual(paths(changes.changed), ["state.json"]);
                  assert.isTrue(
                    paths(changes.created).some((path) => path.startsWith("state.json.v7.backup-")),
                  );
                  for (const path of paths(changes.created))
                    assert.isTrue(
                      /^state\.json\.v7\.backup-|^library\.sqlite(?:-shm|-wal)?$/.test(path),
                    );
                }
              }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
          );
    });
  });
});

describe("skit sync", () => {
  describe("Choosing between changes", () => {
    describe("Conflicts leave both Libraries unchanged.", () => {
      for (const scenario of casesFor([
        "Merge: conflicted writes nothing",
        "Merge: resolution_invalid writes nothing",
      ]))
        it.effect(`oracle row: ${scenario.row}`, () =>
          Effect.gen(function* () {
            yield* scenario.run(yield* devices);
          }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
        );
    });
  });
});

describe("skit sync", () => {
  describe("Choosing between changes", () => {
    describe("A retried conflict still requires the selected Registry choice.", () => {
      for (const scenario of casesFor([
        "Merge: after M5 before M7 (--take-remote must be repeated)",
      ]))
        it.effect(`oracle row: ${scenario.row}`, () =>
          Effect.gen(function* () {
            yield* scenario.run(yield* devices);
          }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
        );
    });
  });
});

describe("skit sync", () => {
  describe("Recovering interrupted work", () => {
    describe("A refused Library sync leaves the saved Library records unchanged.", () => {
      for (const scenario of casesFor([
        "Push: before P2 (failed upload)",
        "Push: P2 loses the CAS on the first push",
        "Pull: U3 finds a concurrent local write (SyncLocalChanged)",
        "Merge: M3 finds a concurrent local write (SyncLocalChanged)",
        "Merge: M3 stops a merge that would upload and write before either",
        "Pull: U3 stops before writing a --keep-enabled choice",
        "Merge: a lost CAS merges the changed head from the incorporated head",
        "Merge: before M5 (failed upload after retaining remote originals)",
      ]))
        it.effect(`oracle row: ${scenario.row}`, () =>
          Effect.gen(function* () {
            yield* scenario.run(yield* devices);
          }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
        );
    });
  });
});

describe("skit sync", () => {
  describe("Recovering interrupted work", () => {
    describe("Sync reports changed saved files instead of replacing them.", () => {
      for (const scenario of casesFor(["Preflight: local_bytes_changed preserves every store"]))
        it.effect(`oracle row: ${scenario.row}`, () =>
          Effect.gen(function* () {
            yield* scenario.run(yield* devices);
          }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
        );
    });
  });
});

describe("skit sync", () => {
  describe("Recovering interrupted work", () => {
    describe("A failed Library sync can be retried without losing a Registry change already accepted.", () => {
      for (const scenario of casesFor([
        "Push: refused locally before sending, then local enabled intent changes",
        "Push: collision choice survives refused publication with subsequent compatible edits",
        "Push: HTTP 500 after commit is verified by reading the head",
        "Push: P2 response lost before P4",
        "Push: a changed device choice is refused before remote write",
        "Push: lost response is verified before another home writes",
        "Pull: before U4 (failed local publish)",
        "Merge: after M5 before M7 (failed local publish)",
      ]))
        it.effect(`oracle row: ${scenario.row}`, () =>
          Effect.gen(function* () {
            yield* scenario.run(yield* devices);
          }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
        );
    });
  });
});

describe("skit sync", () => {
  describe("Recovering interrupted work", () => {
    describe("A failed download does not save a partial fresh Library.", () => {
      it.effect("a failed snapshot download retains nothing and leaves the remote unchanged", () =>
        Effect.gen(function* () {
          const { a, b, fs, inject, server } = yield* devices;
          yield* a.importSource("first");
          yield* a.importSource("second");
          yield* a.sync();
          const before = server.stored;
          inject({ _tag: "FailDownload", hash: server.remote!.manifest.snapshot_digests[1]! });
          const progress: string[] = [];
          const failure = yield* Effect.flip(
            b.sync({
              restoreProgress: {
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
    });
  });
});

describe("skit sync", () => {
  describe("Recovering interrupted work", () => {
    describe("Sync reuses a verified saved download.", () => {
      it.effect("sync reuses an orphan retained snapshot without downloading it", () =>
        Effect.gen(function* () {
          const { a, b, c, fs, inject, server } = yield* devices;
          yield* a.importSource("first");
          yield* a.sync();
          const hash = server.remote!.manifest.snapshot_digests[0]!;
          const destination = originalTreePath(join(b.home, "originals"), hash);
          yield* fs.makeDirectory(join(destination, ".."), { recursive: true });
          yield* fs.copy(originalTreePath(join(a.home, "originals"), hash), destination);
          inject({ _tag: "FailDownload", hash });
          const before = yield* b.unchanged;
          const preview = yield* b.sync({ apply: false });
          assert.strictEqual(preview.status, "pull_ready");
          assert.strictEqual("snapshots" in preview ? preview.snapshots : undefined, 0);
          yield* before.check;
          const applied = yield* b.sync();
          assert.strictEqual(applied.status, "pulled");
          assert.strictEqual("snapshots" in applied ? applied.snapshots : undefined, 0);
          assert.strictEqual((yield* b.state).collections.length, 1);
          // The unused fault still rejects a fresh device, proving b made no download request.
          assert.strictEqual(
            (yield* c.sync().pipe(Effect.flip))._tag,
            "Library.LibraryApiRejected",
          );
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );
    });
  });
});

describe("skit sync", () => {
  describe("Recovering interrupted work", () => {
    describe("Sync remembers which Registry changes its saved Library includes.", () => {
      it.effect("oracle: applying paths retain local results and send the revision they read", () =>
        Effect.gen(function* () {
          const { a, b, events, server } = yield* devices;
          const committed = <A, E, R>(sync: Effect.Effect<A, E, R>) =>
            Effect.gen(function* () {
              events.length = 0;
              const exit = yield* Effect.exit(sync);
              // A stopped operation must not pass merely because its writes happened in order.
              assert.isTrue(Exit.isSuccess(exit), events.join(","));
              return [...events];
            });
          const ordered = (
            recorded: readonly string[],
            device: "a" | "b",
            remoteEvents: readonly string[],
          ) => {
            const firstSave = recorded.findIndex((event) => event === `save ${device}`);
            assert.isAtLeast(firstSave, 0, "Sync must durably record its local result");
            assert.deepStrictEqual(
              recorded.filter((event) => event !== `save ${device}`),
              remoteEvents,
            );
          };
          yield* a.importSource("first");
          ordered(yield* committed(a.sync()), "a", ["upload", "write on null"]);
          const pushed = server.remote!.revision_id;
          ordered(yield* committed(b.sync()), "b", []);
          yield* b.importSource("second");
          ordered(yield* committed(b.sync()), "b", ["upload", `write on ${pushed}`]);
          const merged = server.remote!.revision_id;
          yield* a.importSource("third");
          const incorporatedHead = server.remote;
          assert.ok(incorporatedHead);
          let checkedBeforeSend = false;
          ordered(
            yield* committed(
              a.sync({
                progress: {
                  tick: () => Effect.void,
                  around: (phase, work) =>
                    Effect.gen(function* () {
                      if (phase.kind === "save-remote") {
                        const local = yield* a.state.pipe(Effect.orDie);
                        assert.strictEqual(local.collections.length, 3);
                        assert.strictEqual(
                          local.sync_ancestry?.revision_id,
                          incorporatedHead.revision_id,
                        );
                        assert.deepStrictEqual(
                          local.sync_ancestry?.base_manifest,
                          incorporatedHead.manifest,
                        );
                        checkedBeforeSend = true;
                      }
                      return yield* work;
                    }),
                },
              }),
            ),
            "a",
            ["upload", `write on ${merged}`],
          );
          assert.isTrue(checkedBeforeSend);
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );
    });
  });
});

describe("skit sync", () => {
  describe("Keeping device choices", () => {
    describe("An installed-copy failure does not undo an already completed Library sync.", () => {
      for (const scenario of casesFor([
        "Push: after P4 before P5",
        "Pull: after U4 before U5",
        "Merge: after M7 before M8",
        "Clean: after anchoring before reconciliation",
      ]))
        it.effect(`oracle row: ${scenario.row}`, () =>
          Effect.gen(function* () {
            yield* scenario.run(yield* devices);
          }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
        );
    });
  });
});

describe("skit sync", () => {
  describe("Keeping device choices", () => {
    describe("Sync leaves an unapproved edit to an installed Skill unchanged.", () => {
      for (const scenario of casesFor([
        "Push: an edited copy is recorded with its observed bytes before reconciliation",
        "Merge: an edited copy is recorded with its observed bytes before reconciliation",
      ]))
        it.effect(`oracle row: ${scenario.row}`, () =>
          Effect.gen(function* () {
            yield* scenario.run(yield* devices);
          }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
        );
    });
  });
});
