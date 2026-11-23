import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { fixture } from "./helpers/library-values.js";
import { skitLayer } from "../src/platform/layer.js";
import {
  decodeLibraryState,
  libraryManifestFromLocalState,
  libraryStateRevision,
} from "../src/library/library-state.js";
import { makeCollectionId, makeSkillId, makeSkillVersionId } from "../src/library/entity-ids.js";
import { librarySnapshotDigests } from "../src/library/library-contracts.js";
import { prepareLibraryMerge } from "../src/library/internal/sync/merge.js";
import { canonicalJson, type JsonObject } from "../src/shared/json.js";
import {
  LibraryDifference,
  prepareLibraryDifference,
  prepareLibrarySide,
} from "../src/library/store/difference.js";

it.effect(
  "identical ancestry is stored once and both shared and existing differences restore either side",
  () =>
    Effect.gen(function* () {
      const { state } = yield* fixture;
      const after = { ...state, installed_skills: [], extension: { next: null } };
      const difference = yield* prepareLibraryDifference(state, after, "fixture");
      assert.strictEqual(difference.sameAncestry, true);
      assert.ok(difference.beforeAncestry);
      assert.isFalse(Object.hasOwn(difference, "afterAncestry"));
      const { sameAncestry: _shared, ...separate } = difference;
      const existing = { ...separate, afterAncestry: difference.beforeAncestry };
      for (const input of [difference, existing]) {
        const stored = yield* Schema.decodeEffect(Schema.fromJsonString(LibraryDifference))(
          yield* Schema.encodeEffect(Schema.fromJsonString(LibraryDifference))(input),
        );
        for (const current of [state, after])
          for (const side of ["before", "after"] as const)
            assert.strictEqual(
              canonicalJson(yield* prepareLibrarySide(stored, current, side, "fixture")),
              canonicalJson(side === "before" ? state : after),
            );
      }
      assert.isBelow(JSON.stringify(difference).length, JSON.stringify(existing).length);
      for (const invalid of [
        { ...difference, beforeAncestry: undefined },
        { ...difference, afterAncestry: difference.beforeAncestry },
      ]) {
        assert.isFalse(Schema.is(LibraryDifference)(invalid));
        assert.strictEqual(
          (yield* Effect.flip(prepareLibrarySide(invalid, state, "after", "fixture")))._tag,
          "InvalidLibraryState",
        );
      }
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("different relative bases and removal of ancestry never share a reference", () =>
  Effect.gen(function* () {
    const { state } = yield* fixture;
    const { sync_ancestry: _accepted, ...absent } = state;
    const localEdit = {
      ...state,
      enabled: [{ skill: state.skills[0]!.skill_id }],
    };
    const remoteEdit = {
      ...state,
      sync_ancestry: { ...state.sync_ancestry!, revision_id: "another-head" },
    };
    for (const after of [localEdit, remoteEdit, absent]) {
      const difference = yield* prepareLibraryDifference(state, after, "fixture");
      assert.isFalse(
        Object.hasOwn(difference, "sameAncestry"),
        after === localEdit ? "local edit" : after === remoteEdit ? "remote edit" : "absence",
      );
      for (const current of [state, after])
        for (const side of ["before", "after"] as const)
          assert.strictEqual(
            canonicalJson(yield* prepareLibrarySide(difference, current, side, "fixture")),
            canonicalJson(side === "before" ? state : after),
          );
    }
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("shuffled catalogue rows leave revision, merge and recovery unchanged", () =>
  Effect.gen(function* () {
    const { state } = yield* fixture;
    const shuffled = {
      ...state,
      collections: state.collections.toReversed(),
      skills: state.skills.toReversed().map((skill) => ({
        ...skill,
        versions: skill.versions.toReversed(),
      })),
      collection_versions: state.collection_versions.toReversed().map((version) => ({
        ...version,
        members: version.members.toReversed(),
      })),
      imports: state.imports.toReversed(),
    };
    assert.strictEqual(libraryStateRevision(state), libraryStateRevision(shuffled));
    const difference = yield* prepareLibraryDifference(state, shuffled, "fixture");
    assert.deepStrictEqual(difference.rows, []);
    assert.strictEqual(difference.beforeHash, difference.afterHash);

    const after = { ...state, extension: { applied: true } };
    const recorded = yield* prepareLibraryDifference(state, after, "fixture");
    assert.deepStrictEqual(
      yield* prepareLibrarySide(recorded, shuffled, "after", "fixture"),
      after,
    );

    const manifest = yield* libraryManifestFromLocalState(state);
    const remote = yield* libraryManifestFromLocalState(shuffled);
    const merge = (remote: typeof manifest) =>
      prepareLibraryMerge({ base: manifest, local: manifest, remote, device: state });
    assert.deepStrictEqual(yield* merge(remote), yield* merge(manifest));
  }).pipe(Effect.provide(skitLayer)),
);

const richPair = Effect.gen(function* () {
  const { state } = yield* fixture;
  const skill = state.skills[0]!;
  const source = state.imports[0]!;
  const extension = { absent: null, empty: [], nested: { ["__proto__"]: [true, false] } };
  const enabled = { skill: skill.skill_id, collection: skill.collection_id, extension };
  const lock = {
    type: "skills.sh-lock",
    machine_id: source.machine_id,
    read_at: "",
    lock_path: { value: "/lock", extension },
    lock_version: 1,
    lock_scope: "project",
    lock_content_hash: skill.versions[0]!.source_hash,
    source: "source",
    source_type: "local",
    skill_name: "skill",
    content_agreement: "agrees",
    original_entry_hash: skill.versions[0]!.source_hash,
    original_entry: { arbitrary: { extension } },
    upstream_baseline: {
      source_revision: "rev",
      skill_path: "skill",
      tree_oid: "tree",
      lock_hash_kind: "computedHash",
      lock_hash: "hash",
      verification: "lock-only",
      established_at: "",
      search_scope: "ref-path-history",
      extension,
    },
    extension,
  };
  const next = yield* decodeLibraryState({
    ...state,
    collections: state.collections.toReversed().map((item) => ({
      ...item,
      upstream: {
        source_identity: {
          kind: "git",
          remote: { value: "git://example/" + item.collection_id, extension },
          collection_root: ".",
          extension,
        },
        tracking: { kind: "default", extension },
        extension,
      },
    })),
    skills: state.skills.toReversed().map((item) => ({
      ...item,
      local_version_id: item.versions[0]!.skill_version_id,
      versions: item.versions.toReversed(),
    })),
    collection_versions: state.collection_versions
      .toReversed()
      .map((item) => ({ ...item, extension, members: item.members.toReversed() })),
    imports: state.imports.toReversed().map((item) => ({
      ...item,
      extension,
      source_identity: {
        ...item.source_identity,
        path: { value: "/source/" + item.import_id, extension },
        extension,
      },
      lock_file_entries: [lock, lock],
    })),
    device_skill_selection: {
      mode: "choose",
      enabled: [enabled, { skill: makeSkillId(), extension }],
      invocation_policies: { unknown: { extension }, null: null },
      extension,
    },
    repositories: [
      {
        root: "/repo-z",
        enabled: [enabled],
        invocation_policies: { unknown: { extension }, null: null },
        extension,
      },
      ...state.repositories,
    ],
    unmanaged: state.unmanaged.map((item) => ({ ...item, harnesses: ["codex", "codex"] })),
    ownershipIssues: [...(state.ownershipIssues ?? []), ...(state.ownershipIssues ?? [])].map(
      (item) => ({ ...item, markerReason: { _tag: "NotObject", extension }, extension }),
    ),
    installed_skills: state.installed_skills.toReversed().map((item, index) =>
      index === 0
        ? {
            ...item,
            status: "conflicted",
            current_hash: item.expected_hash,
            conflicts: [
              { _tag: "MarkerMissing", extension },
              { _tag: "MarkerMissing", extension },
              {
                _tag: "InstalledSkillMismatch",
                actual: item.installed_skill_id,
                expected: item.installed_skill_id,
                extension,
              },
              { _tag: "MarkerInvalid", reason: { _tag: "NotObject", extension }, extension },
            ],
          }
        : index === 1
          ? {
              ...item,
              status: "suppressed",
              suppression_reason: "native_delete",
              suppressed_at: "",
              current_hash: null,
            }
          : { ...item, current_hash: null, suppressed_at: null },
    ),
  });
  const manifest = yield* libraryManifestFromLocalState(next);
  const target = yield* decodeLibraryState({
    ...next,
    sync_ancestry: {
      ...next.sync_ancestry,
      base_manifest: {
        ...manifest,
        collections: [
          ...manifest.collections
            .toReversed()
            .map((item, index) => (index === 0 ? { ...item, label: "remote" } : item)),
          { collection_id: makeCollectionId(), label: "remote-only", extension },
        ],
        skills: manifest.skills.toReversed().slice(1),
        collection_versions: manifest.collection_versions.toReversed(),
        imports: manifest.imports.toReversed(),
        extension,
      },
      extension,
    },
  });

  return { state, target };
});

it.effect(
  "difference rebuilds either side from either side after its JSON codec, preserving the step-1 fixture exactly",
  () =>
    Effect.gen(function* () {
      const { state, target } = yield* richPair;
      const difference = yield* prepareLibraryDifference(state, target, "fixture");
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(LibraryDifference))(
        difference,
      );
      const stored = yield* Schema.decodeEffect(Schema.fromJsonString(LibraryDifference))(encoded);
      assert.isFalse(encoded.includes('"base_manifest"'));
      for (const current of [state, target]) {
        for (const side of ["before", "after"] as const) {
          const expected = side === "before" ? state : target;
          const actual = yield* prepareLibrarySide(stored, current, side, "fixture");
          assert.strictEqual(canonicalJson(actual), canonicalJson(expected));
          assert.strictEqual(libraryStateRevision(actual), libraryStateRevision(expected));
        }
      }
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "real merge with a Version alias and Collection removal rebuilds both ways, including each accepted manifest",
  () =>
    Effect.gen(function* () {
      const { state } = yield* fixture;
      const before = yield* decodeLibraryState({
        ...state,
        installed_skills: [],
        enabled: [{ skill: state.skills[1]!.skill_id }],
      });
      const manifest = yield* libraryManifestFromLocalState(before);
      const removed = manifest.collections.at(-1)!.collection_id;
      const alias = makeSkillVersionId();
      const remoteRows = {
        ...manifest,
        collections: manifest.collections.filter((x) => x.collection_id !== removed),
        skills: manifest.skills
          .filter((x) => x.collection_id !== removed)
          .map((x, index) =>
            index === 1
              ? {
                  ...x,
                  versions: x.versions.map((v, i) =>
                    i === 0 ? { ...v, skill_version_id: alias } : v,
                  ),
                }
              : x,
          ),
        imports: manifest.imports.filter((x) => x.collection_id !== removed),
      };
      const remote = {
        ...remoteRows,
        collection_versions: remoteRows.collection_versions.filter((x) =>
          remoteRows.imports.some((i) => i.collection_version_id === x.collection_version_id),
        ),
        snapshot_digests: librarySnapshotDigests({
          ...remoteRows,
          collection_versions: remoteRows.collection_versions.filter((x) =>
            remoteRows.imports.some((i) => i.collection_version_id === x.collection_version_id),
          ),
        }),
      };
      const merged = yield* prepareLibraryMerge({
        base: manifest,
        local: manifest,
        remote,
        device: before,
      });
      if (merged._tag !== "Ready") return assert.fail("Expected merged pair");
      const after = yield* decodeLibraryState({
        ...merged.device,
        collections: merged.manifest.collections,
        skills: merged.manifest.skills,
        collection_versions: merged.manifest.collection_versions,
        imports: merged.manifest.imports,
        enabled: merged.manifest.enabled,
        sync_ancestry: {
          ...before.sync_ancestry,
          revision_id: "accepted-next",
          base_manifest: remote,
        },
      });
      assert.isTrue(
        after.skills
          .find((x) => x.skill_id === manifest.skills[1]!.skill_id)!
          .versions.some((x) => x.skill_version_id === alias),
      );
      assert.isFalse(after.collections.some((x) => x.collection_id === removed));
      const difference = yield* prepareLibraryDifference(before, after, "fixture");
      const stored = yield* Schema.decodeEffect(Schema.fromJsonString(LibraryDifference))(
        yield* Schema.encodeEffect(Schema.fromJsonString(LibraryDifference))(difference),
      );
      for (const current of [before, after])
        for (const side of ["before", "after"] as const) {
          const expected = side === "before" ? before : after;
          const actual = yield* prepareLibrarySide(stored, current, side, "fixture");
          assert.strictEqual(canonicalJson(actual), canonicalJson(expected));
          assert.strictEqual(libraryStateRevision(actual), libraryStateRevision(expected));
        }
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "difference rejects a third body and a damaged target, while Installed Skills may progress",
  () =>
    Effect.gen(function* () {
      const { state } = yield* fixture;
      const after = { ...state, enabled: [{ skill: state.skills[0]!.skill_id }] };
      const difference = yield* prepareLibraryDifference(state, after, "fixture");
      const progressed = { ...state, installed_skills: [] };
      assert.strictEqual(
        canonicalJson(yield* prepareLibrarySide(difference, progressed, "after", "fixture")),
        canonicalJson(after),
      );
      for (const current of [
        { ...state, enabled: [], repositories: [] },
        { ...state, extension: "third" },
      ]) {
        const error = yield* Effect.flip(
          prepareLibrarySide(difference, current, "after", "fixture"),
        );
        assert.strictEqual(error._tag, "InvalidLibraryState");
      }
      const error = yield* Effect.flip(
        prepareLibrarySide(
          { ...difference, afterHash: difference.beforeHash },
          state,
          "after",
          "fixture",
        ),
      );
      assert.strictEqual(error._tag, "InvalidLibraryState");
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "difference preserves absent, empty and nullable optional data, and refuses malformed ancestry JSON with a typed failure",
  () =>
    Effect.gen(function* () {
      const { state } = yield* fixture;
      for (const [field, value] of [
        ["assessmentAcceptances", []],
        ["scanIssues", []],
        ["invocation_policies", {}],
        ["device_skill_selection", { mode: "follow-account" }],
        ["pending_device_selection_origin", "https://example.test"],
        ["extension", null],
        ["extension", []],
        ["extension", {}],
      ] as const) {
        const document: JsonObject = JSON.parse(JSON.stringify(state));
        delete document[field];
        const before = yield* decodeLibraryState(document);
        const after = yield* decodeLibraryState({ ...document, [field]: value });
        const difference = yield* prepareLibraryDifference(before, after, "fixture");
        for (const current of [before, after])
          for (const side of ["before", "after"] as const)
            assert.strictEqual(
              canonicalJson(yield* prepareLibrarySide(difference, current, side, "fixture")),
              canonicalJson(side === "before" ? before : after),
            );
      }
      const difference = yield* prepareLibraryDifference(state, state, "fixture");
      assert.ok(difference.beforeAncestry);
      assert.strictEqual(difference.sameAncestry, true);
      const damaged = {
        ...difference,
        beforeAncestry: {
          ...difference.beforeAncestry,
          rows: [
            {
              entity: "skills",
              key: state.skills[0]!.skill_id,
              change: "changed" as const,
              value: "{",
            },
          ],
        },
      };
      const failure = yield* Effect.flip(prepareLibrarySide(damaged, state, "after", "fixture"));
      assert.strictEqual(failure._tag, "InvalidLibraryState");
    }).pipe(Effect.provide(skitLayer)),
);
