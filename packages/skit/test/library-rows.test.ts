import { migrateLibraryDatabase } from "../src/library/store/database.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import { declaredFixture as fixture, makeDeclaredFixture } from "./helpers/library-values.js";
import { skitLayer } from "../src/platform/layer.js";
import {
  canonicalJson,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../src/shared/json.js";
import {
  decodeCurrentState,
  readDatabaseState,
  saveDatabaseState,
  saveLibraryHistory,
} from "../src/library/store/state-file.js";
import { loadLibrary, loadOperations } from "../src/library/store/library-store.js";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { enabledAt } from "../src/library/enabled.js";
import { openLibrary, saveLibrary } from "./helpers/library-store.js";
import { loadLibraryRows } from "../src/library/store/rows.js";
import { withLibraryDatabase } from "../src/library/store/database.js";
import {
  libraryManifestFromLocalState,
  libraryStateRevision,
  emptyLibraryState,
  type LibraryState,
} from "../src/library/library-state.js";
import { diffLibraryState } from "../src/library/audit/state-diff.js";
import { makeCollectionId, makeSkillId, makeOperationId } from "../src/library/entity-ids.js";

it.effect(
  "round trips declared fields, arbitrary original evidence, repetitions and keyed selections",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-rows-" });
      const path = join(home, "library.sqlite");
      // Keep multiple collections and installed skills without repeating the size fixture
      // for every optional-field round trip.
      const { state } = yield* makeDeclaredFixture(2, 8);
      const skill = state.skills[0]!;
      const source = state.imports[0]!;
      const extension = { absent: null, empty: [], nested: { ["__proto__"]: [true, false] } };
      const enabled = { skill: skill.skill_id };
      const lock = {
        type: "skills.sh-lock",
        machine_id: source.machine_id,
        read_at: "",
        lock_path: { value: "/lock" },
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
        },
      };
      const next = yield* decodeCurrentState(path, {
        ...state,
        collections: state.collections.toReversed().map((item) => ({
          ...item,
          upstream: {
            source_identity: {
              kind: "git",
              remote: { value: "git://example/" + item.collection_id },
              collection_root: ".",
            },
            tracking: { kind: "default" },
          },
        })),
        skills: state.skills.toReversed().map((item) => ({
          ...item,
          local_version_id: item.versions[0]!.skill_version_id,
          versions: item.versions.toReversed(),
        })),
        collection_versions: state.collection_versions
          .toReversed()
          .map((item) => ({ ...item, members: item.members.toReversed() })),
        imports: state.imports.toReversed().map((item) => ({
          ...item,

          source_identity: {
            ...item.source_identity,
            path: { value: "/source/" + item.import_id },
          },
          lock_file_entries: [lock, lock],
        })),
        device_skill_selection: {
          mode: "choose",
          enabled: [enabled, { skill: makeSkillId() }],
          invocation_policies: { [skill.skill_id]: "explicit" },
        },
        repositories: [
          {
            root: "/repo-z",
            enabled: [enabled],
            invocation_policies: { [skill.skill_id]: "explicit" },
          },
          ...state.repositories,
        ],
        unmanaged: state.unmanaged.map((item) => ({ ...item, harnesses: ["codex", "codex"] })),
        ownershipIssues: [...(state.ownershipIssues ?? []), ...(state.ownershipIssues ?? [])].map(
          (item) => ({ ...item, markerReason: { _tag: "NotObject" } }),
        ),
        installed_skills: state.installed_skills.toReversed().map((item, index) =>
          index === 0
            ? {
                ...item,
                status: "conflicted",
                current_hash: item.expected_hash,
                conflicts: [
                  { _tag: "MarkerMissing" },
                  { _tag: "MarkerMissing" },
                  {
                    _tag: "InstalledSkillMismatch",
                    actual: item.installed_skill_id,
                    expected: item.installed_skill_id,
                  },
                  { _tag: "MarkerInvalid", reason: { _tag: "NotObject" } },
                ],
              }
            : index === 1
              ? {
                  ...item,
                  status: "suppressed",
                  suppression_reason: "native_delete",
                  suppressed_at: "",
                }
              : item,
        ),
      });
      const manifest = yield* libraryManifestFromLocalState(next);
      const target = yield* decodeCurrentState(path, {
        ...next,
        sync_ancestry: {
          ...next.sync_ancestry,
          base_manifest: {
            ...manifest,
            collections: [
              ...manifest.collections
                .toReversed()
                .map((item, index) => (index === 0 ? { ...item, label: "remote" } : item)),
              { collection_id: makeCollectionId(), label: "remote-only" },
            ],
            skills: manifest.skills.toReversed().slice(1),
            collection_versions: manifest.collection_versions.toReversed(),
            imports: manifest.imports.toReversed(),
          },
        },
      });
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* migrateLibraryDatabase(path);
          yield* sql.withTransaction(saveDatabaseState(path, target, null));
          const loaded = yield* readDatabaseState(path);
          assert.strictEqual(canonicalJson(loaded.state), canonicalJson(target));
          assert.strictEqual(libraryStateRevision(loaded.state!), libraryStateRevision(target));
          // Exercise the optional fields of the saved representation and its whole JSON payloads.
          // The existing decoder decides which empty/null values are valid; every accepted one must survive.
          const optionalPaths: Array<Array<string | number>> = [
            ...[
              "invocation_policies",
              "assessmentAcceptances",
              "ownershipIssues",
              "scanIssues",
              "device_skill_selection",
              "pending_device_selection_origin",
              "sync_ancestry",
            ].map((key) => [key]),
            ["collections", 0, "upstream"],
            ["skills", 0, "local_version_id"],
            ["imports", 0, "revision"],
            ["repositories", 0, "invocation_policies"],
            ["device_skill_selection", "invocation_policies"],
            ...[
              "source_updated_at",
              "source_url",
              "source_base_url",
              "ref",
              "skill_path",
              "computed_hash",
              "skill_folder_hash",
              "well_known_hash",
              "upstream_baseline",
            ].map((key) => ["imports", 0, "lock_file_entries", 0, key]),
            ["installed_skills", 0, "conflicts", 2, "expected"],
            ["installed_skills", 1, "suppressed_at"],
            ...["harnesses", "paths", "lastHash"].map((key) => ["unmanaged", 0, key]),
            ...[
              "markerReason",
              "collectionId",
              "skillId",
              "installedSkillId",
              "expectedHash",
              "matchesExpectedHash",
            ].map((key) => ["ownershipIssues", 0, key]),
            ["assessmentAcceptances", 0, "expiresAt"],
          ];
          let base = loaded.state ?? null;
          for (const parts of optionalPaths)
            for (const replacement of [undefined, null, "", [], {}]) {
              const candidate: JsonObject = JSON.parse(JSON.stringify(target));
              let parent: JsonValue = candidate;
              for (const part of parts.slice(0, -1)) {
                if (Array.isArray(parent) && typeof part === "number") parent = parent[part]!;
                else if (isJsonObject(parent)) parent = parent[String(part)]!;
              }
              const key = String(parts.at(-1));
              if (!isJsonObject(parent)) continue;
              if (replacement === undefined) delete parent[key];
              else parent[key] = replacement;
              const decoded = yield* Effect.result(decodeCurrentState(path, candidate));
              if (decoded._tag === "Failure") {
                assert.strictEqual(decoded.failure._tag, "InvalidLibraryState");
                continue;
              }
              yield* sql.withTransaction(saveDatabaseState(path, decoded.success, base));
              const current = yield* readDatabaseState(path);
              assert.strictEqual(canonicalJson(current.state), canonicalJson(decoded.success));
              assert.strictEqual(
                libraryStateRevision(current.state!),
                libraryStateRevision(decoded.success),
              );
              base = current.state ?? null;
            }
          // The fixture reverses existing Skills. Moving them must leave their rows intact.
          yield* sql`CREATE TRIGGER keep_skill_rows BEFORE DELETE ON library_skills
            BEGIN SELECT RAISE(ABORT, 'reordering deleted an existing Skill'); END`;
          // Reorder and delete rows too, rather than only checking an initial INSERT.
          const reordered = yield* decodeCurrentState(path, {
            ...target,
            skills: target.skills.toReversed(),
            repositories: target.repositories.toReversed(),
            device_skill_selection: {
              mode: "follow-account",
            },
          });
          yield* sql.withTransaction(saveDatabaseState(path, reordered, base));
          assert.strictEqual(
            canonicalJson((yield* readDatabaseState(path)).state),
            canonicalJson(reordered),
          );
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "keeps absent and empty optional values distinct, and rejects invalid nulls before saving",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = join(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-row-optionals-" }),
        "library.sqlite",
      );
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* migrateLibraryDatabase(path);
          let base: LibraryState | null = null;
          for (const next of [
            emptyLibraryState(),
            {
              ...emptyLibraryState(),
              invocation_policies: {},
              assessmentAcceptances: [],
              ownershipIssues: [],
              scanIssues: [],
              device_skill_selection: { mode: "choose", enabled: [], invocation_policies: {} },
            },
            emptyLibraryState(),
          ]) {
            const state = yield* decodeCurrentState(path, next);
            yield* sql.withTransaction(saveDatabaseState(path, state, base));
            const loaded = yield* readDatabaseState(path);
            assert.strictEqual(canonicalJson(loaded.state), canonicalJson(state));
            assert.strictEqual(libraryStateRevision(loaded.state!), libraryStateRevision(state));
            base = loaded.state ?? null;
          }
          for (const field of [
            "invocation_policies",
            "assessmentAcceptances",
            "ownershipIssues",
            "scanIssues",
            "device_skill_selection",
            "pending_device_selection_origin",
            "sync_ancestry",
          ]) {
            const failed = yield* Effect.flip(
              decodeCurrentState(path, { ...emptyLibraryState(), [field]: null }),
            );
            assert.strictEqual(failed._tag, "InvalidLibraryState");
          }
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a load refuses malformed rows without changing operation data", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = join(
      yield* fs.makeTempDirectoryScoped({ prefix: "skit-row-integrity-" }),
      "library.sqlite",
    );
    const { state } = yield* fixture;
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrateLibraryDatabase(path);
        yield* sql.withTransaction(saveDatabaseState(path, state, null));
        yield* sql`UPDATE library_collections SET label='' WHERE collection_id = ${state.collections[0]!.collection_id}`;
        const failed = yield* Effect.flip(readDatabaseState(path));
        assert.strictEqual(failed._tag, "InvalidLibraryState");
        assert.strictEqual(failed.reason._tag, "SchemaInvalid");
      }),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "changes only the installed row and revision, then completes an enable on the saved fixture",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-row-measure-" });
      const path = join(home, "library.sqlite");
      const { state } = yield* fixture;
      yield* saveLibrary(home, state);
      assert.strictEqual(canonicalJson(yield* loadLibrary(home)), canonicalJson(state));
      const sizes = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tables = yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'library_%' ORDER BY name`;
        const result: Record<string, { rows: number; largestJsonBytes: number }> = {};
        for (const table of tables) {
          const rows = yield* sql`SELECT * FROM ${sql(table.name)}`;
          result[table.name] = {
            rows: rows.length,
            largestJsonBytes: Math.max(
              0,
              ...rows.map((row) => new TextEncoder().encode(JSON.stringify(row)).byteLength),
            ),
          };
        }
        return result;
      });
      const initialSizes = yield* withLibraryDatabase(path, sizes, true);
      let next = {
        ...state,
        installed_skills: state.installed_skills.map((row, index) =>
          index === 0 ? { ...row, installed_at: "2026-11-16T00:00:01.000Z" } : row,
        ),
      };
      const measurements = yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
          const before = yield* sql<{ count: number }>`SELECT total_changes() AS count`;
          const action = {
            eventId: makeOperationId(),
            occurredAt: "2026-11-16T00:00:00.000Z",
            workflow: "measure",
          };
          const started = performance.now();
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const saved = yield* saveDatabaseState(path, next, state);
              yield* saveLibraryHistory(path, action, diffLibraryState(state, saved));
            }),
          );
          const firstSaveMilliseconds = performance.now() - started;
          const changed = yield* sql<{ count: number }>`SELECT total_changes() AS count`;
          assert.strictEqual(changed[0]!.count - before[0]!.count, 2); // one UPDATE for each changed row
          const walBytes = Number((yield* fs.stat(path + "-wal")).size);
          const beforeNoop = changed[0]!.count;
          yield* sql.withTransaction(saveDatabaseState(path, next, next));
          assert.strictEqual(
            (yield* sql<{ count: number }>`SELECT total_changes() AS count`)[0]!.count,
            beforeNoop,
          );
          const saveSamples: number[] = [];
          for (let index = 0; index < 5; index++) {
            const base = next;
            const changed = {
              ...base,
              installed_skills: base.installed_skills.map((row, at) =>
                at === 0
                  ? {
                      ...row,
                      installed_at: new Date(Date.UTC(2026, 10, 16, 0, 0, index + 2)).toISOString(),
                    }
                  : row,
              ),
            };
            const start = performance.now();
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const saved = yield* saveDatabaseState(path, changed, base);
                yield* saveLibraryHistory(path, action, diffLibraryState(base, saved));
              }),
            );
            saveSamples.push(performance.now() - start);
            next = changed;
          }
          const saveMilliseconds = saveSamples.toSorted((a, b) => a - b)[2]!;
          const readMilliseconds: number[] = [];
          for (let index = 0; index < 6; index++) {
            const start = performance.now();
            const loaded = yield* readDatabaseState(path);
            if (index) readMilliseconds.push(performance.now() - start);
            assert.strictEqual(canonicalJson(loaded.state), canonicalJson(next));
          }
          const profile: {
            sqlMilliseconds: number[];
            rowsMilliseconds: number[];
            validationMilliseconds: number[];
            hashMilliseconds: number[];
          } = {
            sqlMilliseconds: [],
            rowsMilliseconds: [],
            validationMilliseconds: [],
            hashMilliseconds: [],
          };
          const tables = Object.keys(initialSizes).filter(
            (name) =>
              !["library_import", "library_operations", "library_audit_events"].includes(name),
          );
          for (let index = 0; index < 6; index++) {
            let start = performance.now();
            for (const table of tables) yield* sql`SELECT * FROM ${sql(table)} ORDER BY rowid`;
            const sqlMilliseconds = performance.now() - start;
            start = performance.now();
            const rows = yield* loadLibraryRows(path);
            const rowsMilliseconds = performance.now() - start;
            assert.ok(rows);
            start = performance.now();
            const checked = yield* decodeCurrentState(path, rows.value);
            const validationMilliseconds = performance.now() - start;
            start = performance.now();
            const hash = libraryStateRevision(checked);
            const hashMilliseconds = performance.now() - start;
            assert.strictEqual(hash, libraryStateRevision(next));
            assert.isAbove(rows.revision, 0);
            if (index) {
              profile.sqlMilliseconds.push(sqlMilliseconds);
              profile.rowsMilliseconds.push(rowsMilliseconds);
              profile.validationMilliseconds.push(validationMilliseconds);
              profile.hashMilliseconds.push(hashMilliseconds);
            }
          }
          return {
            saveMilliseconds,
            firstSaveMilliseconds,
            saveSamples,
            walBytes,
            readMilliseconds,
            profile,
          };
        }),
      );
      const library = yield* openLibrary(home);
      // The size fixture has synthetic content hashes, so give the enable real imported bytes.
      const source = join(home, "source");
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(
        join(source, "SKILL.md"),
        "---\nname: benchmark\ndescription: A benchmark skill.\n---\nBenchmark bytes.\n",
      );
      const imported = yield* library.import.collection({
        machineId: state.imports[0]!.machine_id,
        source: { type: "local", path: source },
        input: source,
        importedAt: "2026-11-16T00:00:00.000Z",
        skills: [
          {
            name: "benchmark",
            sourcePath: source,
            relativePath: ".",
            currentHash: yield* deterministicTreeHash(source),
          },
        ],
        lockFileEntries: [],
      });
      const plan = yield* library.plan(
        {
          _tag: "Enabled",
          changes: [
            {
              _tag: "Enable",
              subject: { _tag: "Collection", id: imported.collection.collection_id },
              members: "whole",
              where: [{ kind: "global" }],
            },
          ],
        },
        { base: yield* library.read },
      );
      yield* library.apply({ _tag: "Apply", plan });
      assert.isTrue(
        (enabledAt(yield* loadLibrary(home), { kind: "global" })?.enabled ?? []).some(
          (entry) =>
            "collection" in entry && entry.collection === imported.collection.collection_id,
        ),
      );
      const installed = (yield* loadLibrary(home)).installed_skills.find(
        (row) => row.skill_id === imported.skills[0]!.skill_id,
      );
      assert.ok(installed);
      assert.strictEqual(installed.status, "installed");
      assert.include(
        yield* fs.readFileString(join(installed.path, "SKILL.md")),
        "Benchmark bytes.",
      );
      assert.isFalse(
        (yield* loadOperations(home)).some((operation) => operation._tag === "Pending"),
      );
      const afterEnableSizes = yield* withLibraryDatabase(path, sizes, true);
      const output = process.env.SKIT_LIBRARY_ROW_MEASUREMENTS;
      if (output)
        yield* fs.writeFileString(
          output,
          JSON.stringify({
            fixtureBytes: new TextEncoder().encode(JSON.stringify(state)).byteLength,
            ...measurements,
            initialSizes,
            afterEnableSizes,
          }),
        );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("changing a loaded Skill leaves the accepted Sync base unchanged", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = join(
      yield* fs.makeTempDirectoryScoped({ prefix: "skit-row-base-" }),
      "library.sqlite",
    );
    const { state, future } = yield* fixture;
    assert.ok(future);
    const manifest = yield* libraryManifestFromLocalState(state);
    const current = yield* decodeCurrentState(path, {
      ...state,
      collections: manifest.collections,
      skills: manifest.skills,
      imports: manifest.imports,
      collection_versions: manifest.collection_versions,
    });
    const editCopy = current.collection_versions.find((version) =>
      version.members.some((member) => member.source_hash === future.source_hash),
    );
    assert.ok(editCopy);
    // The local edit bytes arrived after the remote base was accepted.
    const accepted = yield* libraryManifestFromLocalState({
      ...current,
      collection_versions: current.collection_versions.filter(
        (version) => version.collection_version_id !== editCopy.collection_version_id,
      ),
      imports: current.imports.filter(
        (item) => item.collection_version_id !== editCopy.collection_version_id,
      ),
    });
    const original = yield* decodeCurrentState(path, {
      ...current,
      sync_ancestry: {
        origin: "https://example.test",
        library_id: "base",
        revision_id: "accepted",
        base_manifest: accepted,
      },
    });
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* migrateLibraryDatabase(path);
        yield* sql.withTransaction(saveDatabaseState(path, original, null));
        const loaded = yield* readDatabaseState(path);
        assert.ok(loaded.state);
        const changed = structuredClone(loaded.state);
        changed.skills[0]!.versions.push({ ...future, materialization_profile: "plain-skill/v1" });
        assert.strictEqual(
          changed.sync_ancestry!.base_manifest.skills[0]!.versions.length,
          manifest.skills[0]!.versions.length,
        );
        const valid = yield* decodeCurrentState(path, changed);
        yield* sql.withTransaction(saveDatabaseState(path, valid, loaded.state));
        assert.strictEqual(
          canonicalJson((yield* readDatabaseState(path)).state),
          canonicalJson(valid),
        );
      }),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
