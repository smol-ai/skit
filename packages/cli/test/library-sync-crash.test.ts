import { SqlClient } from "effect/sql";
import { sqliteLayer } from "@smolai/skit-core/platform";
import { describe } from "@effect/vitest";
import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { Hash } from "@smolai/skit-core/shared";
import { join } from "node:path";
import type { LibraryFixtureState as LibraryState } from "./helpers/library-home.js";
import { devices } from "./helpers/library-sync-devices.js";

/** Enable one Skill globally with a device-local invocation policy. */
const enable =
  (skillId: string) =>
  (state: LibraryState): LibraryState => ({
    ...state,
    enabled: [...state.enabled, { skill: skillId as LibraryState["skills"][number]["skill_id"] }],
    invocation_policies: {
      ...state.invocation_policies,
      [skillId]: "explicit",
    },
  });

/** A home holding every declared device field next to its portable records. */
const furnished = Effect.fn("Test.furnishedHome")(function* ({
  fs,
  a,
}: Effect.Success<typeof devices>) {
  const first = yield* a.importSource("first", {
    bytes: '---\nname: first\ndescription: Security fixture\n---\nspawn("sh")\n',
  });
  const skill = first.skills[0]!;
  const repository = join(a.home, "..", "a-repository");
  yield* fs.makeDirectory(join(repository, ".agents", "skills"), { recursive: true });
  const owner = yield* a.owner();
  const review = yield* owner.securityReview(skill.skill_id);
  const finding = review.audit.findings.find((finding) => finding.fingerprint !== undefined);
  if (finding?.fingerprint === undefined)
    return yield* Effect.die("Expected an acceptance-eligible finding");
  yield* owner.acceptSecurityFinding(skill.skill_id, {
    fingerprint: yield* Hash.makeEffect(finding.fingerprint),
    principal: "test",
    rationale: "Reviewed subprocess use",
  });
  yield* a.edit((state) => ({
    ...state,
    enabled: [{ skill: skill.skill_id }],
    invocation_policies: { [skill.skill_id]: "explicit" },
    repositories: [{ root: repository, enabled: [{ skill: skill.skill_id }] }],
  }));
  yield* a.project();
  yield* a.project({ kind: "repository", root: repository }, join(repository, ".agents", "skills"));
});

const deviceFields = (state: LibraryState) => ({
  policies: state.invocation_policies,
  repositories: state.repositories,
  assessmentAcceptances: state.assessmentAcceptances,
  installedSkills: state.installed_skills,
});

describe("skit sync", () => {
  describe("Connecting and previewing", () => {
    describe("A new Library keeps records already held by the Registry.", () => {
      /**
       * Restoring an older `state.json`, from a backup or after a write lost to power failure, restores
       * the ancestry it was reconciled with. The next sync must not read the Collections the remote
       * gained since as local deletions and remove them from every device.
       */
      it.effect("an older state.json does not delete Collections the remote gained since", () =>
        Effect.gen(function* () {
          const { fs, a, b, remoteCollections } = yield* devices;
          yield* a.importSource("first");
          yield* a.sync();
          yield* b.sync();
          yield* b.importSource("second");
          yield* b.sync();
          const added = yield* remoteCollections;
          assert.strictEqual(added.length, 2);

          const stateBeforeMerge = join(a.home, "..", "before-merge");
          yield* fs.copy(a.home, stateBeforeMerge);
          assert.strictEqual((yield* a.sync()).status, "merged");
          yield* fs.remove(a.home, { recursive: true });
          yield* fs.copy(stateBeforeMerge, a.home);

          yield* a.sync();
          assert.deepStrictEqual(yield* remoteCollections, added);
          assert.strictEqual((yield* a.state).collections.length, 2);
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );

      it.effect("state without ancestry merges add-only and keeps remote-only Collections", () =>
        Effect.gen(function* () {
          const { a, b, remoteCollections } = yield* devices;
          yield* a.importSource("first");
          yield* a.sync();
          // B has never synced, as a home upgraded from the sidecar-based ancestry has not either.
          yield* b.importSource("second");
          const remoteOnly = yield* remoteCollections;

          assert.strictEqual((yield* b.sync({ apply: false })).status, "merge_ready");
          assert.strictEqual((yield* b.sync()).status, "merged");
          const adopted = yield* remoteCollections;
          assert.strictEqual(adopted.length, 2);
          for (const collectionId of remoteOnly) assert.include(adopted, collectionId);
          assert.strictEqual((yield* a.sync()).status, "merged");
          assert.strictEqual((yield* a.state).collections.length, 2);
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );

      it.effect(
        "an empty-base merge recovers a home whose Library vanished without deleting anything",
        () =>
          Effect.gen(function* () {
            const { a, b, resetRemote, remoteCollections } = yield* devices;
            yield* a.importSource("first");
            yield* a.sync();
            yield* b.sync();
            yield* b.importSource("second");
            yield* resetRemote;

            assert.strictEqual((yield* a.sync({ apply: false })).status, "push_ready");
            assert.strictEqual((yield* a.sync()).status, "pushed");
            assert.strictEqual((yield* b.sync({ apply: false })).status, "merge_ready");
            assert.strictEqual((yield* b.sync()).status, "merged");
            assert.strictEqual((yield* remoteCollections).length, 2);
            assert.strictEqual((yield* a.sync()).status, "merged");
            assert.strictEqual((yield* a.state).collections.length, 2);
            assert.strictEqual((yield* b.sync()).status, "clean");
          }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );
    });
  });
});

describe("skit sync", () => {
  describe("Choosing between changes", () => {
    describe("A Collection removal is decided for the whole Collection.", () => {
      for (const removalSyncsFirst of [true, false])
        it.effect(
          `a removal wins over enabling its Skill elsewhere (removal syncs first=${removalSyncsFirst})`,
          () =>
            Effect.gen(function* () {
              const { a, b, remote } = yield* devices;
              yield* a.importSource("first");
              yield* a.importSource("second");
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
                assert.deepStrictEqual(state.enabled, []);
                assert.strictEqual((yield* device.sync()).status, "clean");
              }
              assert.isFalse(
                (yield* remote)!.manifest.collections.some(
                  (item) => item.collection_id === removed,
                ),
              );
            }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
        );
    });
  });
});

describe("skit sync", () => {
  describe("Recovering interrupted work", () => {
    describe("An unresolved earlier sync cannot silently overwrite a later edit.", () => {
      it.effect("each sync saves state with the revision it reconciled against", () =>
        Effect.gen(function* () {
          const { a, b, remote } = yield* devices;
          const anchoredAt = (state: typeof a.state) =>
            Effect.gen(function* () {
              const head = yield* remote;
              const ancestry = (yield* state).sync_ancestry;
              assert.strictEqual(ancestry?.revision_id, head?.revision_id);
              assert.strictEqual(ancestry?.library_id, head?.library_id);
            });
          yield* a.importSource("first");
          assert.strictEqual((yield* a.sync()).status, "pushed");
          yield* anchoredAt(a.state);
          assert.strictEqual((yield* b.sync()).status, "pulled");
          yield* anchoredAt(b.state);
          yield* b.importSource("second");
          assert.strictEqual((yield* b.sync()).status, "merged");
          yield* anchoredAt(b.state);
          assert.strictEqual((yield* a.sync()).status, "merged");
          yield* anchoredAt(a.state);
          assert.strictEqual((yield* b.sync()).status, "clean");
          yield* anchoredAt(b.state);
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );

      it.effect("a write committed without a response leaves coherent state and converges", () =>
        Effect.gen(function* () {
          const { a, b, inject, remoteCollections, remote } = yield* devices;
          yield* a.importSource("first");
          yield* a.sync();
          yield* b.sync();
          yield* a.importSource("second");
          const { sync_ancestry: _beforeAncestry, ...stateBefore } = yield* a.state;

          inject({ _tag: "DropAfterCommit" });
          assert.strictEqual((yield* a.sync()).status, "merged");
          const { sync_ancestry: afterAncestry, ...stateAfter } = yield* a.state;
          assert.deepStrictEqual(stateAfter, stateBefore);
          assert.deepStrictEqual(afterAncestry?.base_manifest, (yield* remote)?.manifest);
          assert.strictEqual(afterAncestry?.revision_id, (yield* remote)?.revision_id);
          const committed = yield* remoteCollections;
          assert.strictEqual(committed.length, 2);

          // Read-back already proved the write; the next sync has nothing to change.
          assert.strictEqual((yield* a.sync()).status, "clean");
          assert.deepStrictEqual(yield* remoteCollections, committed);
          assert.strictEqual((yield* b.sync()).status, "merged");
          assert.strictEqual((yield* b.state).collections.length, 2);
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );

      it.effect("a verified lost response establishes the base for a later remote edit", () =>
        Effect.gen(function* () {
          const { a, c, inject, remote } = yield* devices;
          yield* a.importSource("first");
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
          assert.strictEqual((yield* a.sync()).status, "merged");
          // C saw A's committed label and deliberately replaced it.
          assert.strictEqual((yield* c.sync()).status, "merged");
          yield* c.edit(relabel("from-c"));
          assert.strictEqual((yield* c.sync()).status, "merged");

          const retried = yield* a.sync();
          assert.strictEqual(retried.status, "merged");
          assert.strictEqual((yield* remote)?.manifest.collections[0]?.label, "from-c");
          assert.strictEqual((yield* a.state).collections[0]?.label, "from-c");
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );
    });
  });
});

describe("skit sync", () => {
  describe("Recovering interrupted work", () => {
    describe("Sync remembers which Registry changes its saved Library includes.", () => {
      for (const ancestry of ["missing", "stale"] as const)
        it.effect(
          `a clean sync anchoring ${ancestry} ancestry records one completed Sync and preserves undeclared fields`,
          () =>
            Effect.gen(function* () {
              const { fs, a, b, remote } = yield* devices;
              yield* a.importSource("first");
              if (ancestry === "stale") yield* a.sync();
              // Seed an extension written by a newer build into the authoritative row.
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql`UPDATE library_device SET revision=revision+1,extra=json_set(COALESCE(extra,'{}'),'$.extension',json('{"kept":[null,false,false]}')) WHERE id=1`;
                }).pipe(Effect.provide(sqliteLayer({ filename: join(a.home, "library.sqlite") }))),
              );
              const backup = join(a.home, "..", "ancestry-backup");
              yield* fs.copy(a.home, backup);
              if (ancestry === "missing") yield* a.sync();
              else {
                yield* b.sync();
                const label = (yield* b.state).collections[0]!.label;
                yield* b.edit((state) => ({
                  ...state,
                  collections: state.collections.map((collection) => ({
                    ...collection,
                    label: "temporary",
                  })),
                }));
                yield* b.sync();
                yield* b.edit((state) => ({
                  ...state,
                  collections: state.collections.map((collection) => ({ ...collection, label })),
                }));
                yield* b.sync();
              }
              const head = (yield* remote)!;
              yield* fs.remove(a.home, { recursive: true });
              yield* fs.copy(backup, a.home);
              const before = yield* a.state;
              const beforeHistory = yield* (yield* a.owner()).history;
              const saves = a.saves;
              assert.strictEqual((yield* a.sync({ apply: false })).status, "clean");
              assert.strictEqual(a.saves, saves);
              assert.deepStrictEqual(yield* a.state, before);

              assert.strictEqual((yield* a.sync()).status, "clean");
              const afterHistory = yield* (yield* a.owner()).history;
              assert.deepStrictEqual(afterHistory.operations, beforeHistory.operations);
              assert.strictEqual(afterHistory.events.length, beforeHistory.events.length + 1);
              assert.isTrue(
                afterHistory.events
                  .at(-1)
                  ?.changes.some((change) => change.action === "operation-Done"),
              );
              const anchored = yield* a.state;
              assert.deepStrictEqual(Reflect.get(anchored, "extension"), {
                kept: [null, false, false],
              });
              assert.strictEqual(anchored.sync_ancestry?.revision_id, head.revision_id);
              const saved = a.saves;
              assert.strictEqual((yield* a.sync()).status, "clean");
              assert.strictEqual(a.saves, saved);
              assert.deepStrictEqual(yield* a.state, anchored);
            }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
        );
    });
  });
});

describe("skit sync", () => {
  describe("Recovering interrupted work", () => {
    describe("Sync sends removals made since this Library last synced.", () => {
      it.effect("a local removal after sync still removes the Collection everywhere", () =>
        Effect.gen(function* () {
          const { a, b, remoteCollections } = yield* devices;
          yield* a.importSource("first");
          const removed = (yield* a.state).collections[0];
          assert.ok(removed);
          yield* a.importSource("second");
          yield* a.sync();
          yield* b.sync();

          yield* a.remove(removed.collection_id);
          assert.ok((yield* a.state).sync_ancestry, "ordinary mutations keep sync ancestry");
          assert.strictEqual((yield* a.sync()).status, "merged");
          assert.notInclude(yield* remoteCollections, removed.collection_id);
          assert.strictEqual((yield* b.sync()).status, "merged");
          assert.isFalse(
            (yield* b.state).collections.some(
              (item) => item.collection_id === removed.collection_id,
            ),
          );
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );
    });
  });
});

describe("skit sync", () => {
  describe("Keeping device choices", () => {
    describe("Sync keeps this device’s installation choices local.", () => {
      it.effect("a merge keeps device-local invocation policies", () =>
        Effect.gen(function* () {
          const { a, b } = yield* devices;
          yield* a.importSource("first");
          const skillId = (yield* a.state).skills[0]!.skill_id;
          yield* a.edit(enable(skillId));
          yield* a.sync();
          yield* b.sync();
          yield* b.importSource("second");
          yield* b.sync();

          assert.strictEqual((yield* a.sync()).status, "merged");
          const merged = yield* a.state;
          assert.strictEqual(merged.collections.length, 2);
          assert.deepStrictEqual(merged.invocation_policies, {
            [skillId]: "explicit",
          });
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );

      it.effect("every declared device field survives a push, a merge and a clean sync", () =>
        Effect.gen(function* () {
          const homes = yield* devices;
          const { a, b, remote } = homes;
          yield* furnished(homes);
          const before = yield* a.state;
          assert.strictEqual(before.installed_skills.length, 2);

          assert.strictEqual((yield* a.sync()).status, "pushed");
          const pushed = yield* a.state;
          assert.deepStrictEqual(deviceFields(pushed), deviceFields(before));
          assert.deepStrictEqual(
            [pushed.collections, pushed.skills, pushed.imports, pushed.collection_versions],
            [before.collections, before.skills, before.imports, before.collection_versions],
          );
          assert.strictEqual(pushed.sync_ancestry?.revision_id, (yield* remote)?.revision_id);

          yield* b.sync();
          yield* b.importSource("second");
          yield* b.sync();
          assert.strictEqual((yield* a.sync()).status, "merged");
          const merged = yield* a.state;
          assert.deepStrictEqual(deviceFields(merged), deviceFields(before));
          assert.includeDeepMembers(merged.imports, before.imports);
          assert.includeDeepMembers(merged.collection_versions, before.collection_versions);
          assert.strictEqual(merged.collections.length, 2);
          assert.strictEqual(merged.sync_ancestry?.revision_id, (yield* remote)?.revision_id);

          assert.strictEqual((yield* a.sync()).status, "clean");
          assert.deepStrictEqual(yield* a.state, merged);
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );

      it.effect("sync preserves fields this CLI does not declare", () =>
        Effect.gen(function* () {
          const { fs, a, b, c } = yield* devices;
          yield* a.importSource("first");
          // These are pre-database documents from a build with an extra field, imported once.
          yield* fs.makeDirectory(c.home, { recursive: true });
          yield* fs.copy(join(a.home, "originals"), join(c.home, "originals"));
          yield* fs.writeFileString(
            join(c.home, "state.json"),
            JSON.stringify({ ...(yield* a.state), extension: { kept: true } }),
          );
          assert.strictEqual((yield* c.sync({ apply: false })).status, "push_ready");
          assert.isTrue(Object.hasOwn(yield* c.state, "extension"));
          assert.strictEqual((yield* c.sync()).status, "pushed");
          assert.deepStrictEqual(Reflect.get(yield* c.state, "extension"), { kept: true });

          yield* fs.makeDirectory(b.home, { recursive: true });
          yield* fs.copy(join(c.home, "originals"), join(b.home, "originals"));
          yield* fs.writeFileString(
            join(b.home, "state.json"),
            JSON.stringify({ ...(yield* c.state), extension: { kept: true } }),
          );
          assert.strictEqual((yield* b.sync()).status, "clean");
          assert.isTrue(Object.hasOwn(yield* b.state, "extension"));
          yield* a.importSource("second");
          yield* a.sync();
          assert.strictEqual((yield* b.sync()).status, "merged");
          assert.deepStrictEqual(Reflect.get(yield* b.state, "extension"), { kept: true });
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );
    });
  });
});

describe("skit sync", () => {
  describe("Keeping device choices", () => {
    describe("An obstructed installation stops sync before saving its local Library change.", () => {
      it.effect("an obstructed install directory is refused before Sync publishes locally", () =>
        Effect.gen(function* () {
          const { fs, a, b, remote, server } = yield* devices;
          yield* a.importSource("first");
          yield* a.edit(enable((yield* a.state).skills[0]!.skill_id));
          yield* a.sync();
          yield* fs.writeFileString(b.root, "not a directory\n");
          const head = yield* remote;
          const writes = server.writeRequests;
          const failure = yield* Effect.flip(b.sync());
          assert.strictEqual(failure._tag, "PlatformError");
          assert.isFalse(yield* fs.exists(join(b.home, "state.json")));
          assert.strictEqual(yield* fs.readFileString(b.root), "not a directory\n");
          assert.strictEqual(server.writeRequests, writes);
          assert.deepStrictEqual(yield* remote, head);
          yield* fs.remove(b.root);
          assert.strictEqual((yield* b.sync()).status, "pulled");
          assert.isTrue(yield* fs.exists(join(b.root, "first", "SKILL.md")));
        }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
      );
    });
  });
});
