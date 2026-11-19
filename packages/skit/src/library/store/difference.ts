import { Effect, Schema } from "effect";
import {
  canonicalJson,
  arrayAt,
  isJsonObject,
  objectAt,
  stringAt,
  JsonObject,
} from "../../shared/json.js";
import { Hash, sha256Hash } from "../../shared/hash.js";
import {
  decodeLibraryState,
  prepareLibrarySets,
  LibraryStateDocument,
  type LibraryState,
} from "../library-state.js";
import { InstalledSkill } from "../device-state.js";
import { InvalidLibraryState } from "../failures.js";

/** The same keyed comparison drives database writes, operation differences and accepted bases. */
export function prepareRowDifference<A>(
  before: readonly A[],
  after: readonly A[],
  key: (row: A) => string,
) {
  const prior = new Map(before.map((row) => [key(row), row]));
  const desired = new Map(after.map((row) => [key(row), row]));
  const changes: Array<{ key: string; before?: A; after?: A }> = [];
  for (const row of before)
    if (!desired.has(key(row))) changes.push({ key: key(row), before: row });
  for (const row of after) {
    const previous = prior.get(key(row));
    if (previous === undefined) changes.push({ key: key(row), after: row });
    else if (canonicalJson(previous) !== canonicalJson(row))
      changes.push({ key: key(row), before: previous, after: row });
  }
  const beforeKeys = before.map(key);
  const afterKeys = after.map(key);
  const forward = beforeKeys
    .filter((id) => desired.has(id))
    .concat(afterKeys.filter((id) => !prior.has(id)));
  return {
    changes,
    ...(canonicalJson(afterKeys) === canonicalJson(forward) ? {} : { afterOrder: afterKeys }),
  };
}

const entities: readonly {
  field: "collections" | "skills" | "collection_versions" | "imports";
  id: string;
}[] = [
  { field: "collections", id: "collection_id" },
  { field: "skills", id: "skill_id" },
  { field: "collection_versions", id: "collection_version_id" },
  { field: "imports", id: "import_id" },
];
interface ManifestDifferenceRow {
  readonly [field: string]: string | null;
  readonly entity: string;
  readonly key: string;
  readonly change: "added" | "changed" | "removed";
  readonly value: string | null;
}

/** Accepted remote rows are stored relative to this side, exactly as library_sync_base stores them. */
export function prepareManifestRows(
  local: JsonObject,
  manifest: JsonObject,
): ManifestDifferenceRow[] {
  const rows: ManifestDifferenceRow[] = [];
  if (canonicalJson(manifest.enabled) !== canonicalJson(local.enabled))
    rows.push({
      entity: "enabled",
      key: "",
      change: "changed",
      value: JSON.stringify(manifest.enabled),
    });
  for (const entity of entities) {
    const here = arrayAt(local, entity.field).filter(isJsonObject);
    const there = arrayAt(manifest, entity.field).filter(isJsonObject);
    const difference = prepareRowDifference(here, there, (row) => stringAt(row, entity.id) ?? "");
    for (const change of difference.changes)
      rows.push({
        entity: entity.field,
        key: change.key,
        change:
          change.after === undefined
            ? "added"
            : change.before === undefined
              ? "removed"
              : "changed",
        value: change.after === undefined ? null : JSON.stringify(change.after),
      });
  }
  return rows;
}

/** Rebuild the accepted manifest without sharing mutable row objects with the local side. */
export const readManifestRows = Effect.fn("Library.readManifestRows")(function* (
  local: JsonObject,
  metadata: JsonObject,
  rows: readonly Record<string, string | number | null>[],
) {
  const manifest = structuredClone(metadata);
  for (const entity of entities) {
    const original = arrayAt(local, entity.field).filter(isJsonObject);
    const entries = new Map(
      original.map((row) => [stringAt(row, entity.id) ?? "", structuredClone(row)]),
    );
    const changes = rows.filter((row) => row.entity === entity.field);
    for (const change of changes) {
      if (change.value === null) entries.delete(String(change.key));
      else if (typeof change.value === "string")
        entries.set(
          String(change.key),
          yield* Schema.decodeEffect(Schema.fromJsonString(JsonObject))(change.value),
        );
    }
    manifest[entity.field] = [...entries]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, row]) => row);
  }
  const enabled = rows.find((row) => row.entity === "enabled");
  manifest.enabled =
    typeof enabled?.value === "string"
      ? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.MutableJson))(enabled.value)
      : structuredClone(local.enabled);
  return manifest;
});

const change = Schema.Struct({
  key: Schema.String,
  before: Schema.optionalKey(JsonObject),
  after: Schema.optionalKey(JsonObject),
});
const catalogueRows = Schema.Struct({
  field: Schema.Literals(["collections", "skills", "collection_versions", "imports"]),
  changes: Schema.Array(change),
});
const ancestry = Schema.Struct({
  metadata: JsonObject,
  manifest: JsonObject,
  rows: Schema.Array(
    Schema.Struct({
      entity: Schema.String,
      key: Schema.String,
      change: Schema.Literals(["added", "changed", "removed"]),
      value: Schema.NullOr(Schema.String),
    }),
  ),
});
const installed = Schema.Array(
  Schema.declare(Schema.is(InstalledSkill), {
    identifier: "DifferenceInstalledSkill",
    toCodecJson: () => undefined,
  }),
);
export const LibraryDifference = Schema.Struct({
  beforeHash: Hash,
  afterHash: Hash,
  rows: Schema.Array(catalogueRows),
  fields: Schema.Array(
    Schema.Struct({
      field: Schema.String,
      before: Schema.optionalKey(Schema.Json),
      after: Schema.optionalKey(Schema.Json),
    }),
  ),
  beforeAncestry: Schema.optionalKey(ancestry),
  afterAncestry: Schema.optionalKey(ancestry),
  sameAncestry: Schema.optionalKey(Schema.Literal(true)),
  installedSkills: Schema.Struct({ before: installed, after: installed }),
}).check(
  Schema.makeFilter(
    (difference) =>
      difference.sameAncestry !== true ||
      (difference.beforeAncestry !== undefined && difference.afterAncestry === undefined),
    { message: "Shared ancestry requires one before value and no after value" },
  ),
);
export type LibraryDifference = typeof LibraryDifference.Type;

const hashBody = ({ installed_skills: _rows, ...state }: JsonObject) =>
  sha256Hash(new TextEncoder().encode(canonicalJson(state)));

/** Fix old/new row values and compact accepted bases before recording the operation. */
export const prepareLibraryDifference = Effect.fn("Library.prepareDifference")(function* (
  before: LibraryState,
  after: LibraryState,
  path: string,
) {
  const document = (state: LibraryState) =>
    Schema.encodeEffect(Schema.fromJsonString(LibraryStateDocument))(
      prepareLibrarySets(state),
    ).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(JsonObject))));
  const [a, b] = yield* Effect.all([document(before), document(after)]).pipe(
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );
  const rows: Array<typeof catalogueRows.Type> = [];
  for (const entity of entities) {
    const difference = prepareRowDifference(
      arrayAt(a, entity.field).filter(isJsonObject),
      arrayAt(b, entity.field).filter(isJsonObject),
      (row) => stringAt(row, entity.id) ?? "",
    );
    if (difference.changes.length) rows.push({ field: entity.field, changes: difference.changes });
  }
  const remaining = (document: JsonObject) =>
    Object.entries(document)
      .filter(
        ([field]) =>
          !entities.some((entity) => entity.field === field) &&
          field !== "installed_skills" &&
          field !== "sync_ancestry",
      )
      .map(([field, value]) => ({ field, value }));
  const fields = prepareRowDifference(remaining(a), remaining(b), (row) => row.field).changes.map(
    (change) => ({
      field: change.key,
      ...(change.before === undefined ? {} : { before: change.before.value }),
      ...(change.after === undefined ? {} : { after: change.after.value }),
    }),
  );
  const bases = [a, b].map((document) => {
    const accepted = objectAt(document, "sync_ancestry");
    if (!accepted) return undefined;
    const manifest = objectAt(accepted, "base_manifest") ?? {};
    return {
      metadata: Object.fromEntries(
        Object.entries(accepted).filter(([key]) => key !== "base_manifest"),
      ),
      manifest: Object.fromEntries(
        Object.entries(manifest).filter(
          ([key]) => key !== "enabled" && !entities.some((entity) => entity.field === key),
        ),
      ),
      rows: prepareManifestRows(document, manifest),
    };
  });
  const sameAncestry =
    bases[0] !== undefined && canonicalJson(bases[0]) === canonicalJson(bases[1]);
  const difference: LibraryDifference = {
    beforeHash: yield* hashBody(a),
    afterHash: yield* hashBody(b),
    rows,
    fields,
    ...(bases[0] === undefined ? {} : { beforeAncestry: bases[0] }),
    ...(sameAncestry
      ? { sameAncestry: true as const }
      : bases[1] === undefined
        ? {}
        : { afterAncestry: bases[1] }),
    installedSkills: { before: before.installed_skills, after: after.installed_skills },
  };
  return difference;
});

/** Live progress may change Installed Skills; every other field must still be one recorded side. */
export const prepareLibrarySide = Effect.fn("Library.prepareSide")(function* (
  difference: LibraryDifference,
  current: LibraryState,
  side: "before" | "after",
  path: string,
) {
  return yield* Effect.gen(function* () {
    if (
      difference.sameAncestry &&
      (difference.beforeAncestry === undefined || difference.afterAncestry !== undefined)
    )
      return yield* new InvalidLibraryState({ path, reason: { _tag: "InvalidData" } });
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(LibraryStateDocument))(
      prepareLibrarySets(current),
    );
    const document = yield* Schema.decodeEffect(Schema.fromJsonString(JsonObject))(encoded);
    const currentHash = yield* hashBody(document);
    if (currentHash !== difference.beforeHash && currentHash !== difference.afterHash)
      return yield* new InvalidLibraryState({ path, reason: { _tag: "InvalidData" } });
    for (const list of difference.rows) {
      const entity = entities.find((entity) => entity.field === list.field);
      if (entity === undefined)
        return yield* new InvalidLibraryState({
          path,
          reason: { _tag: "InvalidData", issue: "Unknown Library difference field" },
        });
      const rows = new Map(
        arrayAt(document, list.field)
          .filter(isJsonObject)
          .map((row) => [stringAt(row, entity.id) ?? "", row]),
      );
      for (const change of list.changes) {
        const value = change[side];
        if (value === undefined) rows.delete(change.key);
        else rows.set(change.key, structuredClone(value));
      }
      document[list.field] = [...rows]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, row]) => row);
    }
    for (const change of difference.fields) {
      if (Object.hasOwn(change, side))
        Object.defineProperty(document, change.field, {
          value: structuredClone(change[side]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      else delete document[change.field];
    }
    const accepted =
      side === "before" || difference.sameAncestry
        ? difference.beforeAncestry
        : difference.afterAncestry;
    if (accepted) {
      const manifest = yield* readManifestRows(document, accepted.manifest, accepted.rows);
      document.sync_ancestry = { ...structuredClone(accepted.metadata), base_manifest: manifest };
    } else delete document.sync_ancestry;
    if (
      (yield* hashBody(document)) !==
      (side === "before" ? difference.beforeHash : difference.afterHash)
    )
      return yield* new InvalidLibraryState({ path, reason: { _tag: "InvalidData" } });
    return yield* decodeLibraryState({
      ...document,
      installed_skills: structuredClone(difference.installedSkills[side]),
    });
  }).pipe(
    Effect.catchTag("SchemaError", (failure) =>
      Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
    ),
  );
});
