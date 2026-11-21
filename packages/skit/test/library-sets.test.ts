import { asV9 } from "./helpers/released-library.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import {
  decodeLibraryState,
  emptyLibraryState,
  libraryStateRevision,
  prepareLibrarySets,
  type LibraryState,
} from "../src/library/library-state.js";
import { loadLibrary, LibraryWriter, writeLibrary } from "../src/library/store/library-store.js";
import {
  withDatabaseTransaction,
  withLibraryDatabase,
  libraryDatabasePath,
} from "../src/library/store/database.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import { skitLayer } from "../src/platform/layer.js";
import { fixture, declaredFixture } from "./helpers/library-values.js";

it.effect("selection hashes ignore set order and preserve unknown nested values", () =>
  Effect.gen(function* () {
    const { state } = yield* fixture;
    const a = state.skills[0]!.skill_id,
      b = state.skills[1]!.skill_id;
    const before = yield* decodeLibraryState({
      ...state,
      enabled: [{ skill: a, extension: [2, 1, 2] }, { skill: b }],
      repositories: [
        { root: "/b", enabled: [{ skill: b }, { skill: a }] },
        { root: "/a", enabled: [{ skill: a }] },
      ],
      device_skill_selection: {
        mode: "choose",
        enabled: [{ skill: b }, { skill: a }],
        invocation_policies: {},
      },
    });
    const after: LibraryState = {
      ...before,
      enabled: before.enabled.toReversed(),
      repositories: before.repositories
        .toReversed()
        .map((row) => ({ ...row, enabled: row.enabled.toReversed() })),
      device_skill_selection: {
        ...before.device_skill_selection,
        mode: "choose",
        enabled:
          before.device_skill_selection?.mode === "choose"
            ? before.device_skill_selection.enabled.toReversed()
            : [],
      },
    };
    assert.strictEqual(libraryStateRevision(before), libraryStateRevision(after));
    assert.deepStrictEqual(prepareLibrarySets(before), prepareLibrarySets(after));
    assert.deepStrictEqual(
      (yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          enabled: Schema.Array(
            Schema.Struct({ extension: Schema.optionalKey(Schema.Array(Schema.Int)) }),
          ),
        }),
      )(before)).enabled.find((row) => row.extension)?.extension,
      [2, 1, 2],
    );
  }),
);

it.effect("empty optional policy sets have one model representation in all scopes", () =>
  Effect.gen(function* () {
    const state = yield* decodeLibraryState({
      ...emptyLibraryState(),
      invocation_policies: {},
      repositories: [{ root: "/repo", enabled: [], invocation_policies: {} }],
      device_skill_selection: { mode: "choose", enabled: [], invocation_policies: {} },
    });
    assert.isFalse(Object.hasOwn(state, "invocation_policies"));
    assert.isFalse(Object.hasOwn(state.repositories[0]!, "invocation_policies"));
    assert.isFalse(Object.hasOwn(state.device_skill_selection!, "invocation_policies"));
  }),
);

it.effect("reordering selections updates no enabled rows", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-keyed-enabled-" });
    const { state } = yield* declaredFixture;
    const next = yield* decodeLibraryState({
      ...state,
      enabled: [{ skill: state.skills[0]!.skill_id }, { skill: state.skills[1]!.skill_id }],
    });
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        yield* (yield* LibraryWriter).save(next, yield* loadLibrary(home));
      }),
    );
    yield* withDatabaseTransaction(
      home,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER no_enabled_delete BEFORE DELETE ON library_enabled BEGIN SELECT RAISE(ABORT,'set order is not a write'); END`;
      }),
    );
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        yield* writer.save({ ...next, enabled: next.enabled.toReversed() }, next);
      }),
    );
    assert.deepStrictEqual(yield* loadLibrary(home), next);
    yield* withLibraryDatabase(
      libraryDatabasePath(home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const columns = yield* sql<{
          name: string;
          pk: number;
        }>`PRAGMA table_info(library_enabled)`;
        assert.deepStrictEqual(
          columns.filter((row) => row.pk).map((row) => row.name),
          ["scope", "root", "item_key"],
        );
      }),
      true,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("duplicate enabled keys refuse a released source without dropping rows", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-duplicate-enabled-" });
    const { state } = yield* declaredFixture;
    const {
      sync_ancestry: _ancestry,
      device_skill_selection: _selection,
      ownershipIssues: _issues,
      assessmentAcceptances: _acceptances,
      ...released
    } = state;
    const item = { skill: state.skills[0]!.skill_id };
    const raw = JSON.stringify(asV9({ ...released, enabled: [item, item] }));
    const path = join(home, "state.json");
    yield* fs.writeFileString(path, raw);
    const failed = yield* Effect.flip(migrateLocalLibraryState(home));
    assert.strictEqual(failed._tag, "InvalidLibraryState");
    if (failed._tag === "InvalidLibraryState")
      assert.strictEqual(failed.reason._tag, "SchemaInvalid");
    assert.strictEqual(yield* fs.readFileString(path), raw);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
