import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skitLayer } from "../src/platform/layer.js";
import {
  makeImportId,
  makeCollectionId,
  makeMachineId,
  makeInstalledSkillId,
  makeCollectionVersionId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";
import { currentSkillVersion, type Enabled } from "../src/library/library-contracts.js";
import {
  emptyLibraryState,
  globalEnabled,
  type LibraryState,
} from "../src/library/library-state.js";
import { inspectLibrary, saveLibrary } from "./helpers/library-store.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "library-state");

const bindingEntries = (enabled: readonly Enabled[]) =>
  enabled.map((item) =>
    "skill" in item
      ? { kind: "skill", skill_id: item.skill }
      : { kind: "collection", collection_id: item.collection },
  );

/** A current state written as the v9 document it migrates from, so tests can build older states. */
const asV9 = ({
  schemaVersion: _schemaVersion,
  collection_versions,
  imports,
  enabled,
  invocation_policies,
  repositories,
  installed_skills,
  ...fields
}: LibraryState) => {
  assert.isUndefined(fields.sync_ancestry);
  assert.isUndefined(fields.device_skill_selection);
  assert.isUndefined(fields.ownershipIssues);
  return {
    ...fields,
    schemaVersion: 9,
    retained_copies: collection_versions.map(({ collection_version_id, ...copy }) => ({
      ...copy,
      retained_copy_id: collection_version_id,
    })),
    acquisitions: imports.map(
      ({ import_id, kind, collection_version_id, imported_at, lock_file_entries, ...item }) => ({
        ...item,
        acquisition_id: import_id,
        kind: kind === "edit" ? "retained-edit" : kind,
        retained_copy_id: collection_version_id,
        acquired_at: imported_at,
        observations: lock_file_entries,
      }),
    ),
    global_bindings:
      enabled.length > 0 || invocation_policies !== undefined
        ? [
            {
              scope: { kind: "global" },
              entries: bindingEntries(enabled),
              ...(invocation_policies === undefined ? {} : { invocation_policies }),
            },
          ]
        : [],
    local_bindings: repositories.map((repository) => ({
      scope: { kind: "repository", root: repository.root },
      entries: bindingEntries(repository.enabled),
      ...(repository.invocation_policies === undefined
        ? {}
        : { invocation_policies: repository.invocation_policies }),
    })),
    projections: installed_skills.map(
      ({ installed_skill_id, destination, installed_at, ...copy }) => ({
        ...copy,
        projection_id: installed_skill_id,
        target: destination,
        projected_at: installed_at,
      }),
    ),
  };
};

interface LegacySkillVersionFixture {
  readonly [field: string]: unknown;
}

it.effect("v8 state migrates to account-following without changing portable intent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-v8-migration-" });
    yield* fs.writeFileString(
      join(home, "state.json"),
      JSON.stringify({ ...asV9(emptyLibraryState()), schemaVersion: 8 }),
    );
    const migrated = yield* inspectLibrary(home);
    assert.isTrue(migrated.present);
    if (!migrated.present) return;
    assert.strictEqual(migrated.state.schemaVersion, 10);
    assert.isUndefined(migrated.state.device_skill_selection);
    assert.deepStrictEqual(globalEnabled(migrated.state), { enabled: migrated.state.enabled });
    assert.isTrue(
      (yield* fs.readDirectory(home)).some((name) => name.startsWith("state.json.v8.backup-")),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("migrates a persisted v4 well-known subset to v10 once at the state-file boundary", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-v4-migration-" });
    const fixture = yield* fs.readFileString(join(fixtures, "v4-well-known-subset.json"));
    yield* fs.writeFileString(join(home, "state.json"), fixture);

    const migrated = yield* inspectLibrary(home);
    assert.strictEqual(migrated.present, true);
    if (!migrated.present) return;
    assert.strictEqual(migrated.state.schemaVersion, 10);
    assert.strictEqual(migrated.state.collections.length, 1);
    assert.strictEqual(migrated.state.imports[0]?.kind, "source");
    assert.strictEqual(
      migrated.state.imports[0]?.collection_id,
      migrated.state.collections[0]?.collection_id,
    );
    assert.strictEqual(
      migrated.state.imports[0]?.input.value,
      "wellknown:https://skills.example#skills=review",
    );
    assert.deepStrictEqual(Object.keys(migrated.state.collections[0]?.upstream ?? {}).sort(), [
      "source_identity",
      "tracking",
    ]);
    assert.strictEqual(
      migrated.state.skills[0]?.collection_id,
      migrated.state.collections[0]?.collection_id,
    );
    const skillId = migrated.state.skills[0]!.skill_id;
    const collectionId = migrated.state.collections[0]!.collection_id;
    // Every current Skill of the Collection was bound, so the Collection is bound.
    assert.deepStrictEqual(migrated.state.enabled, [{ collection: collectionId }]);
    assert.strictEqual(migrated.state.invocation_policies?.[skillId], "explicit");
    assert.deepStrictEqual(migrated.state.repositories, [
      {
        root: "/workspace",
        enabled: [{ collection: collectionId }],
        invocation_policies: { [skillId]: "implicit" },
      },
    ]);
    assert.strictEqual(migrated.state.installed_skills.length, 1);
    assert.strictEqual(
      migrated.state.installed_skills[0]?.skill_id,
      migrated.state.skills[0]?.skill_id,
    );
    assert.strictEqual("collection_id" in migrated.state.installed_skills[0]!, false);

    assert.ok(
      (yield* fs.readDirectory(home)).some((name) => name.startsWith("state.json.v4.backup-")),
    );

    const reopened = yield* inspectLibrary(home);
    assert.strictEqual(reopened.present, true);
    if (!reopened.present) return;
    assert.deepStrictEqual(reopened.state, migrated.state);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("merges legacy well-known subsets from the same origin deterministically", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-v4-merge-" });
    const fixture = JSON.parse(
      yield* fs.readFileString(join(fixtures, "v4-well-known-subset.json")),
    );
    const firstCollection = fixture.collections[0];
    const firstSkill = fixture.skills[0];
    const firstAcquisition = fixture.acquisitions[0];
    const secondCollectionId = makeCollectionId();
    const secondAcquisitionId = makeImportId();
    const secondCopyId = makeCollectionVersionId();
    fixture.retained_copies.push({
      ...fixture.retained_copies[0],
      retained_copy_id: secondCopyId,
      digest: `sha256:${"c".repeat(64)}`,
      members: fixture.retained_copies[0].members.map((member: object) => ({
        ...member,
        source_path: "tdd",
      })),
    });
    fixture.collections.push({
      ...firstCollection,
      collection_id: secondCollectionId,
      display_name: "skills.example#tdd",
    });
    fixture.skills.push({
      ...firstSkill,
      skill_id: makeSkillId(),
      collection_id: secondCollectionId,
      path: "tdd",
      name: "tdd",
      upstream_path: "tdd",
      versions: firstSkill.versions.map((version: LegacySkillVersionFixture) => {
        const skillVersionId = makeSkillVersionId();
        return {
          ...version,
          skill_version_id: skillVersionId,
          origins: [{ acquisition_id: secondAcquisitionId, source_path: "tdd" }],
        };
      }),
    });
    fixture.skills[1].selected_skill_version_id = fixture.skills[1].versions[0].skill_version_id;
    fixture.acquisitions.push({
      ...firstAcquisition,
      acquisition_id: secondAcquisitionId,
      retained_copy_id: secondCopyId,
      input: { value: "wellknown:https://skills.example#skills=tdd" },
      acquired_at: "2026-09-20T00:01:00.000Z",
    });
    yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(fixture));

    const migrated = yield* inspectLibrary(home);
    assert.strictEqual(migrated.present, true);
    if (!migrated.present) return;
    assert.strictEqual(migrated.state.collections.length, 1);
    assert.strictEqual(new Set(migrated.state.skills.map((skill) => skill.collection_id)).size, 1);
    assert.strictEqual(
      migrated.state.skills[0]?.collection_id,
      migrated.state.collections[0]?.collection_id,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("migrates v5 state: whole Sources, entries, retained edits, all history kept", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-v5-migration-" });
    const machineId = makeMachineId();
    const collectionId = makeCollectionId();
    const digest = (character: string) => `sha256:${character.repeat(64)}`;
    const ids = {
      alpha: makeSkillId(),
      beta: makeSkillId(),
      gone: makeSkillId(),
      dropped: makeSkillId(),
      alpha1: makeSkillVersionId(),
      alpha2: makeSkillVersionId(),
      beta1: makeSkillVersionId(),
      betaEdit: makeSkillVersionId(),
      gone1: makeSkillVersionId(),
      dropped1: makeSkillVersionId(),
      first: makeImportId(),
      second: makeImportId(),
      edit: makeImportId(),
      firstCopy: makeCollectionVersionId(),
      secondCopy: makeCollectionVersionId(),
      editCopy: makeCollectionVersionId(),
    };
    const version = (id: string, character: string, origins: [string, string][]) => ({
      skill_version_id: id,
      source_digest: digest(character),
      artifact_digest: digest(character),
      validation_identity_digest: digest(character),
      materialization_profile: "plain-skill/v1",
      origins: origins.map(([acquisition_id, source_path]) => ({ acquisition_id, source_path })),
    });
    const member = (source_path: string, character: string) => ({
      source_path,
      source_digest: digest(character),
      artifact_digest: digest(character),
      materialization_profile: "plain-skill/v1",
    });
    const github = {
      kind: "github" as const,
      owner: "fixture",
      repository: "skills",
      collection_root: ".",
    };
    const sourceAcquisition = (id: string, copy: string, revision: string, at: string) => ({
      acquisition_id: id,
      retained_copy_id: copy,
      source_identity: github,
      tracking: { kind: "commit", ref: revision },
      selection: { kind: "selected-paths", paths: ["alpha", "beta", "dropped", "gone"] },
      input: { value: "https://github.com/fixture/skills" },
      source_revision: revision,
      acquired_at: at,
      machine_id: machineId,
      observations: [],
    });
    const v5 = {
      schemaVersion: 5,
      unmanaged: [],
      collections: [
        {
          collection_id: collectionId,
          label: "fixture/skills",
          upstream: {
            source_identity: github,
            tracking: { kind: "default" },
            selection: { kind: "selected-paths", paths: ["alpha", "beta", "dropped", "gone"] },
            last_acquisition_id: ids.second,
          },
        },
      ],
      skills: [
        {
          skill_id: ids.alpha,
          collection_id: collectionId,
          path: "alpha",
          name: "alpha",
          selected_skill_version_id: ids.alpha2,
          versions: [
            version(ids.alpha1, "1", [[ids.first, "alpha"]]),
            version(ids.alpha2, "2", [[ids.second, "alpha"]]),
          ],
        },
        {
          skill_id: ids.beta,
          collection_id: collectionId,
          path: "beta",
          name: "beta",
          selected_skill_version_id: ids.betaEdit,
          versions: [
            version(ids.beta1, "3", [
              [ids.first, "beta"],
              [ids.second, "beta"],
            ]),
            version(ids.betaEdit, "4", [[ids.edit, "."]]),
          ],
        },
        {
          skill_id: ids.gone,
          collection_id: collectionId,
          path: "gone",
          name: "gone",
          selected_skill_version_id: ids.gone1,
          versions: [version(ids.gone1, "5", [[ids.first, "gone"]])],
        },
        {
          skill_id: ids.dropped,
          collection_id: collectionId,
          path: "dropped",
          name: "dropped",
          selected_skill_version_id: ids.dropped1,
          versions: [version(ids.dropped1, "6", [[ids.first, "dropped"]])],
        },
      ],
      retained_copies: [
        {
          retained_copy_id: ids.firstCopy,
          digest: digest("a"),
          copy_profile: "verbatim/v1",
          members: [
            member("alpha", "1"),
            member("beta", "3"),
            member("dropped", "6"),
            member("gone", "5"),
          ],
        },
        {
          retained_copy_id: ids.secondCopy,
          digest: digest("b"),
          copy_profile: "verbatim/v1",
          members: [member("alpha", "2"), member("beta", "3")],
        },
        {
          retained_copy_id: ids.editCopy,
          digest: digest("c"),
          copy_profile: "verbatim/v1",
          members: [member(".", "4")],
        },
      ],
      acquisitions: [
        sourceAcquisition(ids.first, ids.firstCopy, "1".repeat(40), "2026-09-16T01:00:00.000Z"),
        sourceAcquisition(ids.second, ids.secondCopy, "2".repeat(40), "2026-09-16T02:00:00.000Z"),
        {
          acquisition_id: ids.edit,
          retained_copy_id: ids.editCopy,
          source_identity: {
            kind: "local",
            machine_id: machineId,
            path: { value: "/codex/beta" },
          },
          tracking: { kind: "default" },
          selection: { kind: "full-tree" },
          input: { value: "/codex/beta" },
          acquired_at: "2026-09-16T03:00:00.000Z",
          machine_id: machineId,
          observations: [],
        },
      ],
      global_bindings: [
        // Every current Skill (alpha, beta) is bound: this becomes the Collection.
        { harness: "codex", scope: { kind: "global" }, skills: [ids.alpha, ids.beta] },
        // A Skill deleted upstream, bound on its own, is kept.
        { harness: "claude-code", scope: { kind: "global" }, skills: [ids.gone] },
      ],
      local_bindings: [],
      projections: [
        {
          projection_id: makeInstalledSkillId(),
          skill_id: ids.alpha,
          skill_version_id: ids.alpha1,
          harness: "codex",
          root: "/codex",
          path: "/codex/alpha",
          expected_digest: digest("1"),
          status: "installed",
          projected_at: "2026-09-16T01:30:00.000Z",
        },
      ],
    };
    yield* fs.writeFileString(join(home, "state.json"), JSON.stringify(v5));

    const migrated = yield* inspectLibrary(home);
    assert.strictEqual(migrated.present, true);
    if (!migrated.present) return;
    const state = migrated.state;
    assert.strictEqual(state.schemaVersion, 10);
    assert.ok(
      (yield* fs.readDirectory(home)).some((name) => name.startsWith("state.json.v5.backup-")),
    );
    assert.deepStrictEqual(state.collections[0]?.upstream, {
      source_identity: github,
      tracking: { kind: "default" },
    });

    // Migration keeps every import and Skill, even `dropped`, which upstream deleted and
    // nothing uses.
    assert.deepStrictEqual(
      state.imports.map((item) => [item.import_id, item.kind, item.revision]),
      [
        [ids.first, "source", "1".repeat(40)],
        [ids.second, "source", "2".repeat(40)],
        [ids.edit, "edit", undefined],
      ],
    );
    assert.deepStrictEqual(
      state.skills.map((skill) => skill.name),
      ["alpha", "beta", "gone", "dropped"],
    );
    const skill = (id: string) => state.skills.find((candidate) => candidate.skill_id === id)!;
    assert.strictEqual(currentSkillVersion(state, skill(ids.alpha))?.skill_version_id, ids.alpha2);
    assert.deepStrictEqual(
      skill(ids.alpha).versions.map((item) => item.skill_version_id),
      [ids.alpha1, ids.alpha2],
    );
    assert.strictEqual(skill(ids.beta).local_version_id, ids.betaEdit);
    assert.strictEqual(currentSkillVersion(state, skill(ids.beta))?.skill_version_id, ids.betaEdit);
    assert.strictEqual(currentSkillVersion(state, skill(ids.gone))?.skill_version_id, ids.gone1);
    // Per-Harness Bindings merge into one.
    assert.deepStrictEqual(state.enabled, [{ collection: collectionId }, { skill: ids.gone }]);
    assert.deepStrictEqual(
      state.installed_skills.map((projection) => projection.destination),
      ["agents"],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const agreed of [true, false])
  it.effect(
    `migrates v6 per-Harness Bindings into one and marks former roots legacy (agreed=${agreed})`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-v6-migration-" });
        yield* fs.writeFileString(
          join(home, "state.json"),
          yield* fs.readFileString(join(fixtures, "v4-well-known-subset.json")),
        );
        const current = yield* inspectLibrary(home);
        assert.strictEqual(current.present, true);
        if (!current.present) return;
        const { schemaVersion: _current, ...state } = asV9(current.state);
        const skill = state.skills[0]!;
        const version = skill.versions[0]!.skill_version_id;
        const entries = state.global_bindings[0]!.entries;
        const enabled = current.state.enabled;
        const binding = (harness: string, policy: string) => ({
          harness,
          scope: { kind: "global" },
          entries,
          invocation_policies: { [skill.skill_id]: policy },
        });
        const projection = (harness: string, root: string) => ({
          projection_id: makeInstalledSkillId(),
          skill_id: skill.skill_id,
          skill_version_id: version,
          harness,
          root,
          path: join(root, skill.name),
          expected_digest: `sha256:${"1".repeat(64)}`,
          status: "installed",
          projected_at: "2026-09-16T00:00:00.000Z",
        });
        yield* fs.writeFileString(
          join(home, "state.json"),
          JSON.stringify({
            ...state,
            schemaVersion: 6,
            global_bindings: [
              binding("codex", "explicit"),
              binding("opencode", "explicit"),
              binding("claude-code", agreed ? "explicit" : "implicit"),
            ],
            local_bindings: [],
            projections: [
              projection("codex", "/home/.agents/skills"),
              projection("claude-code", "/home/.claude/skills"),
              projection("opencode", "/home/.config/opencode/skills"),
              projection("devin", "/home/.config/devin/skills"),
            ],
          }),
        );

        const migrated = yield* inspectLibrary(home);
        assert.strictEqual(migrated.present, true);
        if (!migrated.present) return;
        assert.strictEqual(migrated.state.schemaVersion, 10);
        assert.deepStrictEqual(migrated.state.enabled, enabled);
        // Harnesses that disagreed leave the Skill on its declared policy.
        assert.deepStrictEqual(
          migrated.state.invocation_policies,
          agreed ? { [skill.skill_id]: "explicit" } : undefined,
        );
        assert.deepStrictEqual(
          migrated.state.installed_skills.map((item) => item.destination),
          ["agents", "claude", "legacy", "legacy"],
        );
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("relabels v7 state as v8 without inventing sync ancestry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-v7-migration-" });
    yield* fs.writeFileString(
      join(home, "state.json"),
      yield* fs.readFileString(join(fixtures, "v4-well-known-subset.json")),
    );
    const current = yield* inspectLibrary(home);
    assert.strictEqual(current.present, true);
    if (!current.present) return;
    yield* fs.writeFileString(
      join(home, "state.json"),
      JSON.stringify({ ...asV9(current.state), schemaVersion: 7 }),
    );

    const migrated = yield* inspectLibrary(home);
    assert.strictEqual(migrated.present, true);
    if (!migrated.present) return;
    assert.deepStrictEqual(migrated.state, current.state);
    assert.notProperty(migrated.state, "sync_ancestry");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("state load and publication retain nested extensions without skipping validation", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-state-extensions-" });
    const path = join(home, "state.json");
    yield* fs.writeFileString(
      path,
      yield* fs.readFileString(join(fixtures, "v4-well-known-subset.json")),
    );
    const current = yield* inspectLibrary(home);
    assert.strictEqual(current.present, true);
    if (!current.present) return;
    const value = {
      ...current.state,
      extension: { retained: true },
      collections: current.state.collections.map((collection) => ({
        ...collection,
        extension: { retained: "collection" },
      })),
    };
    const original = JSON.stringify(value);
    yield* fs.writeFileString(path, original);
    const reopened = yield* inspectLibrary(home);
    assert.deepStrictEqual(reopened, { present: true, state: value });
    assert.strictEqual(yield* fs.readFileString(path), original);

    yield* fs.writeFileString(
      path,
      JSON.stringify({
        ...value,
        collections: value.collections.map((collection) => ({
          ...collection,
          collection_id: "bad-id",
        })),
      }),
    );
    const failure = yield* Effect.flip(inspectLibrary(home));
    assert.strictEqual(failure._tag, "InvalidLibraryState");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("migrates v9 Bindings to enabled lists and renames stored records", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-v9-migration-" });
    yield* fs.writeFileString(
      join(home, "state.json"),
      yield* fs.readFileString(join(fixtures, "v4-well-known-subset.json")),
    );
    const current = yield* inspectLibrary(home);
    assert.strictEqual(current.present, true);
    if (!current.present) return;
    const v9 = asV9(current.state);
    const skill = v9.skills[0]!;
    const collectionId = skill.collection_id;
    const projection = v9.projections[0]!;
    const acquisition = v9.acquisitions[0]!;
    const baseManifest = {
      schema: "skit.library.v7",
      collections: v9.collections,
      skills: v9.skills,
      retained_copies: v9.retained_copies,
      acquisitions: v9.acquisitions,
      snapshot_digests: v9.retained_copies.map((copy) => copy.digest),
      bindings: [
        { scope: { kind: "global" }, entries: [{ kind: "skill", skill_id: skill.skill_id }] },
      ],
    };
    yield* fs.writeFileString(
      join(home, "state.json"),
      JSON.stringify({
        ...v9,
        acquisitions: [
          ...v9.acquisitions,
          {
            ...acquisition,
            acquisition_id: makeImportId(),
            kind: "retained-edit",
            acquired_at: "2026-10-01T00:00:00.000Z",
          },
        ],
        // An empty global Binding keeps its invocation overrides until its copies are updated.
        global_bindings: [
          {
            scope: { kind: "global" },
            entries: [],
            invocation_policies: { [skill.skill_id]: "explicit" },
          },
        ],
        device_skill_selection: {
          mode: "choose",
          binding: {
            scope: { kind: "global" },
            entries: [{ kind: "collection", collection_id: collectionId }],
            invocation_policies: { [skill.skill_id]: "implicit" },
          },
        },
        custodyIssues: [
          {
            code: "ORPHANED_PROJECTION_CLAIM",
            path: projection.path,
            canonicalPath: projection.path,
            harnesses: ["codex"],
            observedHash: projection.expected_digest,
            projectionId: projection.projection_id,
          },
        ],
        sync_ancestry: {
          origin: "https://registry.example",
          library_id: "library",
          revision_id: "revision",
          base_manifest: baseManifest,
        },
      }),
    );

    const migrated = yield* inspectLibrary(home);
    assert.strictEqual(migrated.present, true);
    if (!migrated.present) return;
    const state = migrated.state;
    assert.strictEqual(state.schemaVersion, 10);
    assert.deepStrictEqual(state.enabled, []);
    assert.deepStrictEqual(state.invocation_policies, { [skill.skill_id]: "explicit" });
    assert.deepStrictEqual(state.device_skill_selection, {
      mode: "choose",
      enabled: [{ collection: collectionId }],
      invocation_policies: { [skill.skill_id]: "implicit" },
    });
    assert.deepStrictEqual(state.repositories, current.state.repositories);
    assert.deepStrictEqual(state.collection_versions, current.state.collection_versions);
    assert.deepStrictEqual(
      state.imports.map((item) => item.kind),
      ["source", "edit"],
    );
    assert.deepStrictEqual(state.imports[0], current.state.imports[0]);
    assert.deepStrictEqual(state.installed_skills, current.state.installed_skills);
    assert.deepStrictEqual(state.ownershipIssues, [
      {
        code: "ORPHANED_OWNERSHIP_MARKER",
        path: projection.path,
        canonicalPath: projection.path,
        harnesses: ["codex"],
        currentHash: projection.expected_digest,
        installedSkillId: projection.projection_id,
      },
    ]);
    assert.strictEqual(state.sync_ancestry?.base_manifest.schema, "skit.library.v8");
    assert.deepStrictEqual(state.sync_ancestry?.base_manifest.enabled, [{ skill: skill.skill_id }]);
    assert.deepStrictEqual(
      state.sync_ancestry?.base_manifest.collection_versions,
      current.state.collection_versions,
    );
    assert.isTrue(
      (yield* fs.readDirectory(home)).some((name) => name.startsWith("state.json.v9.backup-")),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
