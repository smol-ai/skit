import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { Collection, Skill, CollectionVersion, Import } from "../library-contracts.js";
import { InvalidLibraryState } from "../failures.js";
import { canonicalJson, isJsonObject, JsonObject, arrayAt, stringAt } from "../../shared/json.js";
import { prepareRowDifference } from "./difference.js";

const entities = [
  { field: "collections", id: "collection_id", valid: Schema.is(Collection) },
  { field: "skills", id: "skill_id", valid: Schema.is(Skill) },
  {
    field: "collection_versions",
    id: "collection_version_id",
    valid: Schema.is(CollectionVersion),
  },
  { field: "imports", id: "import_id", valid: Schema.is(Import) },
] as const;

/** Local catalogue edits must leave the accepted remote values unchanged. */
export const saveCatalogueBase = Effect.fn("Library.saveCatalogueBase")(function* (
  path: string,
  next: JsonObject,
  base: JsonObject,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* sql`SELECT id FROM library_sync WHERE id=1`).length) return;
  for (const entity of entities) {
    const before = arrayAt(base, entity.field).filter(isJsonObject);
    const after = arrayAt(next, entity.field).filter(isJsonObject);
    const key = (row: JsonObject) => stringAt(row, entity.id) ?? "";
    const difference = prepareRowDifference(before, after, key);
    if (!difference.changes.length) continue;
    const stored = yield* sql<{
      key: string;
      change: string;
      value: string | null;
    }>`SELECT key,change,value FROM library_sync_base WHERE entity=${entity.field}`;
    const prior = new Map(stored.map((row) => [row.key, row]));
    const Value = Schema.declare(
      (value: unknown): value is JsonObject => isJsonObject(value) && entity.valid(value),
    );
    for (const change of difference.changes) {
      const previous = prior.get(change.key);
      const agreed = previous
        ? previous.change === "added"
          ? undefined
          : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Value))(previous.value)
        : change.before;
      if (agreed !== undefined && agreed[entity.id] !== change.key)
        return yield* new InvalidLibraryState({
          path,
          reason: {
            _tag: "RowIdentityMismatch",
            field: entity.id,
            expected: change.key,
            actual: stringAt(agreed, entity.id),
          },
        });
      if (canonicalJson(change.after) === canonicalJson(agreed)) {
        if (previous)
          yield* sql`DELETE FROM library_sync_base WHERE entity=${entity.field} AND key=${change.key}`;
      } else {
        const kind =
          agreed === undefined ? "added" : change.after === undefined ? "removed" : "changed";
        const value = agreed === undefined ? null : JSON.stringify(agreed);
        if (previous?.change !== kind || previous.value !== value)
          yield* sql`INSERT INTO library_sync_base(entity,key,change,value) VALUES(${entity.field},${change.key},${kind},${value}) ON CONFLICT(entity,key) DO UPDATE SET change=excluded.change,value=excluded.value`;
      }
    }
  }
});
