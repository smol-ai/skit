import { resolve } from "node:path";
import { Effect, Schema, Struct } from "effect";
import { SqlClient } from "effect/sql";
import { enabledItemKey, type Enabled } from "../library-contracts.js";
import { CollectionId, SkillId } from "../entity-ids.js";
import { InvalidLibraryState, LibraryChanged } from "../failures.js";
import { LibraryStateFields } from "./state-fields.js";
import { canonicalJson, JsonObject } from "../../shared/json.js";
import { diffEnabled } from "../audit/state-diff.js";
import { libraryDatabasePath } from "./database.js";
import { loadEnabledRows, saveEnabledRows } from "./rows.js";
import {
  advanceLibraryRevision,
  readDatabaseStateRevision,
  saveLibraryHistory,
  saveSetupIntentProgress,
  withLibraryTransaction,
} from "./state-file.js";
import type { SetupIntent } from "./setup-intent.js";
import type { HistoryAction } from "./history-action.js";

const fields = [
  "enabled",
  "invocation_policies",
  "repositories",
  "device_skill_selection",
  "pending_device_selection_origin",
] as const;
const EnabledFields = Schema.Struct(Struct.pick(LibraryStateFields, fields));
export type EnabledState = typeof EnabledFields.Type;
export const EnabledState = Schema.declare(Schema.is(EnabledFields)).check(
  Schema.makeFilter((state) => {
    const scopes = [
      state,
      ...state.repositories,
      ...(state.device_skill_selection?.mode === "choose" ? [state.device_skill_selection] : []),
    ];
    return (
      new Set(state.repositories.map((row) => resolve(row.root))).size ===
        state.repositories.length &&
      scopes.every(
        (scope) => new Set(scope.enabled.map(enabledItemKey)).size === scope.enabled.length,
      )
    );
  }),
);

const selected = (state: EnabledState | JsonObject) =>
  Object.fromEntries(
    fields.flatMap((field) => (Object.hasOwn(state, field) ? [[field, state[field]]] : [])),
  );
const ordered = (state: EnabledState) => {
  const list = <A extends { readonly enabled: readonly Enabled[] }>(scope: A) => ({
    ...scope,
    enabled: [...scope.enabled].sort((a, b) => enabledItemKey(a).localeCompare(enabledItemKey(b))),
  });
  return {
    ...list(state),
    repositories: state.repositories.map(list).sort((a, b) => a.root.localeCompare(b.root)),
    ...(state.device_skill_selection?.mode === "choose"
      ? { device_skill_selection: list(state.device_skill_selection) }
      : {}),
  };
};
const setupEnabledIntent = (state: EnabledState): SetupIntent => ({
  global: {
    enabled: state.enabled,
    ...(Object.keys(state.invocation_policies ?? {}).length
      ? { invocation_policies: state.invocation_policies }
      : {}),
  },
  repositories: state.repositories,
  device: state.device_skill_selection ?? null,
  versions: [],
});

/** Audit needs identities and current Collection membership, never Skill documents or file trees. */
const loadEnabledSkillIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT s.skill_id,s.collection_id,
    EXISTS (SELECT 1 FROM library_collection_version_members AS m
      WHERE m.collection_version_id=(SELECT i.collection_version_id FROM library_imports AS i
        WHERE i.collection_id=s.collection_id AND i.kind='source'
        ORDER BY i.imported_at DESC,i.import_id DESC LIMIT 1)
      AND m.source_path=s.path) AS member
    FROM library_skills AS s ORDER BY s.skill_id`;
  const skills = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        skill_id: SkillId,
        collection_id: CollectionId,
        member: Schema.Literals([0, 1]),
      }),
    ),
  )(rows);
  const collections = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ collection_id: CollectionId })),
  )(yield* sql`SELECT collection_id FROM library_collections`);
  return {
    skills: new Set(skills.map((row) => row.skill_id)),
    collections: new Set(collections.map((row) => row.collection_id)),
    expand: (enabled: readonly Enabled[]) => [
      ...new Set(
        enabled.flatMap((item) =>
          "skill" in item
            ? [item.skill]
            : skills
                .filter((row) => row.collection_id === item.collection && row.member === 1)
                .map((row) => row.skill_id),
        ),
      ),
    ],
  };
});

/** Change only selection rows; setup scope progress, audit and freshness commit with them. */
export const saveEnabled = Effect.fn("Library.saveEnabled")(function* (
  home: string,
  nextInput: EnabledState,
  baseInput: EnabledState,
  revision: number,
  action: HistoryAction,
) {
  const path = libraryDatabasePath(home);
  return yield* withLibraryTransaction(
    home,
    Effect.gen(function* () {
      if ((yield* readDatabaseStateRevision(path)).revision !== revision)
        return yield* new LibraryChanged({ path });
      const [next, base] = yield* Schema.decodeUnknownEffect(
        Schema.Tuple([EnabledState, EnabledState]),
      )([selected(nextInput), selected(baseInput)]);
      const current = yield* loadEnabledRows();
      const stored = yield* Schema.decodeUnknownEffect(EnabledState)(selected(current));
      if (canonicalJson(ordered(stored)) !== canonicalJson(ordered(base)))
        return yield* new LibraryChanged({ path });
      if (canonicalJson(ordered(stored)) === canonicalJson(ordered(next))) return revision;
      const catalogue = yield* loadEnabledSkillIds;
      if (
        [next, ...next.repositories].some((scope) =>
          scope.enabled.some((item) =>
            "skill" in item
              ? !catalogue.skills.has(item.skill)
              : !catalogue.collections.has(item.collection),
          ),
        )
      )
        return yield* new InvalidLibraryState({
          path,
          reason: { _tag: "InvalidData", issue: "Enabled subject is missing from the Library" },
        });
      const document = yield* Schema.decodeUnknownEffect(JsonObject)(selected(next));
      yield* saveEnabledRows(current, document);
      yield* saveSetupIntentProgress(path, setupEnabledIntent(stored), setupEnabledIntent(next));
      const accepted = yield* advanceLibraryRevision(path);
      yield* saveLibraryHistory(
        path,
        action,
        diffEnabled(stored, next, catalogue.expand, catalogue.expand),
      );
      return accepted;
    }).pipe(
      Effect.catchTag("SchemaError", (failure) =>
        Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
      ),
    ),
  );
});
