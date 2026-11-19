import { loadInventoryRows, saveInventoryRows, decodeInventoryScan } from "./inventory-rows.js";
import { Enabled, enabledItemKey } from "../library-contracts.js";
import { canonicalJson } from "../../shared/json.js";
import { Array as EffectArray, Effect, Schema, Struct } from "effect";
import { prepareRowDifference, prepareManifestRows, readManifestRows } from "./difference.js";
import { SqlClient } from "effect/sql";
import { arrayAt, isJsonObject, objectAt, JsonObject } from "../../shared/json.js";
import { InstalledSkill } from "../device-state.js";
import type { InstalledSkillId } from "../entity-ids.js";
import { InvalidLibraryState } from "../failures.js";
import { LibraryStateFields } from "./state-fields.js";

interface Field {
  readonly column: string;
  readonly field: string;
  readonly json?: boolean;
}
interface Table {
  readonly name: string;
  readonly keys: readonly string[];
  readonly fields: readonly Field[];
}
type Row = Record<string, string | number | null>;
const fields = (...names: string[]): Field[] => names.map((field) => ({ field, column: field }));
const collections: Table = {
  name: "library_collections",
  keys: ["collection_id"],
  fields: [
    ...fields("collection_id", "label"),
    { field: "upstream", column: "upstream", json: true },
  ],
};
const skills: Table = {
  name: "library_skills",
  keys: ["skill_id"],
  fields: fields("skill_id", "collection_id", "path", "name", "local_version_id"),
};
const versions: Table = {
  name: "library_skill_versions",
  keys: ["skill_version_id"],
  fields: fields(
    "skill_version_id",
    "source_hash",
    "artifact_hash",
    "validation_identity_hash",
    "materialization_profile",
  ),
};
const collectionVersions: Table = {
  name: "library_collection_versions",
  keys: ["collection_version_id"],
  fields: fields("collection_version_id", "hash", "copy_profile"),
};
const members: Table = {
  name: "library_collection_version_members",
  keys: ["collection_version_id", "source_path"],
  fields: fields("source_path", "source_hash", "artifact_hash", "materialization_profile"),
};
const imports: Table = {
  name: "library_imports",
  keys: ["import_id"],
  fields: [
    ...fields(
      "import_id",
      "collection_id",
      "kind",
      "collection_version_id",
      "input",
      "revision",
      "imported_at",
      "machine_id",
    ),
    { field: "source_identity", column: "source_identity", json: true },
    { field: "lock_file_entries", column: "lock_file_entries", json: true },
  ],
};
const enabled: Table = {
  name: "library_enabled",
  keys: ["scope", "root", "item_key"],
  fields: [
    { field: "collection", column: "collection_id" },
    { field: "skill", column: "skill_id" },
  ],
};
const policies: Table = {
  name: "library_invocation_policies",
  keys: ["scope", "root", "skill_id"],
  fields: fields("scope", "root", "skill_id", "policy"),
};
const repositories: Table = {
  name: "library_repositories",
  keys: ["root"],
  fields: fields("root"),
};
const installed: Table = {
  name: "library_installed_skills",
  keys: ["installed_skill_id"],
  fields: [
    ...fields(
      "installed_skill_id",
      "skill_id",
      "skill_version_id",
      "destination",
      "root",
      "path",
      "expected_hash",
      "installed_at",
      "status",
      "current_hash",
      "suppression_reason",
      "suppressed_at",
    ),
    { field: "conflicts", column: "conflicts", json: true },
  ],
};
const acceptances: Table = {
  name: "library_assessment_acceptances",
  keys: [],
  fields: [
    ...fields("fingerprint", "skill_version_id", "context", "principal", "rationale"),
    { field: "artifactContentHash", column: "artifact_content_hash" },
    { field: "acceptedAt", column: "accepted_at" },
    { field: "expiresAt", column: "expires_at" },
  ],
};
const device: Table = {
  name: "library_device",
  keys: ["id"],
  fields: fields("pending_device_selection_origin"),
};
const sync: Table = {
  name: "library_sync",
  keys: ["id"],
  fields: fields("origin", "library_id", "revision_id"),
};
const base: Table = {
  name: "library_sync_base",
  keys: ["entity", "key"],
  fields: fields("entity", "key", "change", "value"),
};
const libraryTables = [
  collections,
  skills,
  versions,
  collectionVersions,
  members,
  imports,
  enabled,
  policies,
  repositories,
  installed,
  acceptances,
  device,
  sync,
  base,
];
const knownFields = new Map(
  libraryTables.map((table) => [table, new Set(table.fields.map((field) => field.field))]),
);
const entities = [
  { field: "collections", id: "collection_id", table: collections },
  { field: "skills", id: "skill_id", table: skills },
  { field: "collection_versions", id: "collection_version_id", table: collectionVersions },
  { field: "imports", id: "import_id", table: imports },
];

/** A row's extra has original field names, including nested objects' remaining fields.
 * A null scalar also stays in extra, so SQL NULL never conflates null with absence. */
function rowOf(value: JsonObject, table: Table, omitted: readonly string[] = []): Row {
  const known = knownFields.get(table);
  const extra = Object.fromEntries(
    Object.entries(value).filter(([key]) => !known?.has(key) && !omitted.includes(key)),
  );
  const row: Row = {};
  for (const field of table.fields) {
    const child = value[field.field];
    if (child === undefined) row[field.column] = null;
    else if (field.json) row[field.column] = JSON.stringify(child);
    else if (typeof child === "string") row[field.column] = child;
    else {
      row[field.column] = null;
      Object.defineProperty(extra, field.field, {
        value: child,
        enumerable: true,
        configurable: true,
      });
    }
  }
  row.extra = Object.keys(extra).length ? JSON.stringify(extra) : null;
  return row;
}
const objectOf = Effect.fn("Library.readRow")(function* (row: Row, table: Table) {
  const value = yield* Schema.decodeEffect(Schema.fromJsonString(JsonObject))(
    typeof row.extra === "string" ? row.extra : "{}",
  );
  for (const field of table.fields) {
    const child = row[field.column];
    if (child !== null && child !== undefined && !Object.hasOwn(value, field.field))
      value[field.field] =
        field.json && typeof child === "string"
          ? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.MutableJson))(child)
          : child;
  }
  return value;
});
const extras = Effect.fn("Library.saveRowExtras")(function* (row: Row, value: JsonObject) {
  const prior = yield* Schema.decodeEffect(Schema.fromJsonString(JsonObject))(
    typeof row.extra === "string" ? row.extra : "{}",
  );
  return { ...row, extra: JSON.stringify({ ...prior, ...value }) };
});
function objects(value: JsonObject, field: string): JsonObject[] {
  return arrayAt(value, field).filter(isJsonObject);
}

const enabledTables = [enabled, policies, repositories, device];

/** Encode only account, device and repository selections, including their extension fields. */
const splitEnabledRows = Effect.fn("Library.splitEnabledRows")(function* (value: JsonObject) {
  const rows = new Map<string, Row[]>(enabledTables.map((table) => [table.name, []]));
  const add = (table: Table, row: Row) => rows.get(table.name)?.push(row);
  const selection = objectAt(value, "device_skill_selection");
  const owners: Array<{ scope: string; root: string; value: JsonObject }> = [
    { scope: "account", root: "", value },
  ];
  if (selection?.mode === "choose") owners.push({ scope: "device", root: "", value: selection });
  for (const repository of objects(value, "repositories")) {
    const root = typeof repository.root === "string" ? repository.root : "";
    owners.push({ scope: "repository", root, value: repository });
    add(
      repositories,
      yield* extras(
        rowOf(repository, repositories, ["enabled", "invocation_policies"]),
        Object.hasOwn(repository, "invocation_policies")
          ? {
              invocation_policies: Object.fromEntries(
                Object.entries(objectAt(repository, "invocation_policies") ?? {}).filter(
                  ([, value]) => typeof value !== "string",
                ),
              ),
            }
          : {},
      ),
    );
  }
  for (const owner of owners) {
    for (const entry of objects(owner.value, "enabled"))
      add(enabled, {
        ...rowOf(entry, enabled),
        scope: owner.scope,
        root: owner.root,
        item_key:
          "skill" in entry
            ? `skill:${typeof entry.skill === "string" ? entry.skill : JSON.stringify(entry.skill)}`
            : `collection:${typeof entry.collection === "string" ? entry.collection : JSON.stringify(entry.collection)}`,
      });
    for (const [skill, policy] of Object.entries(
      objectAt(owner.value, "invocation_policies") ?? {},
    ))
      if (typeof policy === "string")
        add(policies, { scope: owner.scope, root: owner.root, skill_id: skill, policy });
  }
  const omitted = [
    "collections",
    "skills",
    "collection_versions",
    "imports",
    "enabled",
    "repositories",
    "installed_skills",
    "unmanaged",
    "ownershipIssues",
    "scanIssues",
    "assessmentAcceptances",
    "sync_ancestry",
    "device_skill_selection",
    "invocation_policies",
  ];
  let deviceRow = rowOf(value, device, omitted);
  if (Object.hasOwn(value, "invocation_policies"))
    deviceRow = yield* extras(deviceRow, {
      invocation_policies: Object.fromEntries(
        Object.entries(objectAt(value, "invocation_policies") ?? {}).filter(
          ([, value]) => typeof value !== "string",
        ),
      ),
    });
  if (Object.hasOwn(value, "assessmentAcceptances"))
    deviceRow = yield* extras(deviceRow, { assessmentAcceptances: [] });
  if (selection)
    deviceRow = yield* extras(deviceRow, {
      device_skill_selection: Object.fromEntries(
        Object.entries(selection).filter(
          ([key]) =>
            key !== "mode" &&
            (selection.mode !== "choose" || (key !== "enabled" && key !== "invocation_policies")),
        ),
      ),
    });
  if (selection?.mode === "choose" && Object.hasOwn(selection, "invocation_policies")) {
    const extra = yield* Schema.decodeEffect(Schema.fromJsonString(JsonObject))(
      typeof deviceRow.extra === "string" ? deviceRow.extra : "{}",
    );
    deviceRow = yield* extras(deviceRow, {
      device_skill_selection: {
        ...objectAt(extra, "device_skill_selection"),
        invocation_policies: Object.fromEntries(
          Object.entries(objectAt(selection, "invocation_policies") ?? {}).filter(
            ([, value]) => typeof value !== "string",
          ),
        ),
      },
    });
  }
  add(device, {
    ...deviceRow,
    id: 1,
    device_skill_selection: typeof selection?.mode === "string" ? selection.mode : null,
  });
  return rows;
});

const catalogueTables = [collections, skills, versions, collectionVersions, members, imports];

const splitCatalogueRows = Effect.fn("Library.splitCatalogueRows")(function* (value: JsonObject) {
  const rows = new Map<string, Row[]>(catalogueTables.map((table) => [table.name, []]));
  const add = (table: Table, row: Row) => rows.get(table.name)?.push(row);
  for (const entity of entities)
    for (const item of objects(value, entity.field)) {
      let row = rowOf(
        item,
        entity.table,
        entity.table === skills
          ? ["versions"]
          : entity.table === collectionVersions
            ? ["members"]
            : [],
      );
      if (entity.table === imports) {
        const input = objectAt(item, "input") ?? {};
        row = yield* extras(
          { ...row, input: typeof input.value === "string" ? input.value : null },
          { input: Object.fromEntries(Object.entries(input).filter(([key]) => key !== "value")) },
        );
      }
      add(entity.table, row);
      if (entity.table === skills)
        for (const version of objects(item, "versions"))
          add(versions, {
            ...rowOf(version, versions),
            skill_id: typeof item.skill_id === "string" ? item.skill_id : null,
          });
      if (entity.table === collectionVersions)
        for (const member of objects(item, "members"))
          add(members, {
            ...rowOf(member, members),
            collection_version_id:
              typeof item.collection_version_id === "string" ? item.collection_version_id : null,
          });
    }
  return rows;
});

const splitLibraryRows = Effect.fn("Library.splitRows")(function* (value: JsonObject) {
  const rows = new Map<string, Row[]>(libraryTables.map((table) => [table.name, []]));
  // Each table is initialized above, including absent optional aggregates.
  const add = (table: Table, row: Row) => rows.get(table.name)?.push(row);
  for (const [table, entries] of yield* splitCatalogueRows(value)) rows.set(table, entries);
  for (const [table, entries] of yield* splitEnabledRows(value)) rows.set(table, entries);
  for (const entry of objects(value, "installed_skills")) add(installed, rowOf(entry, installed));
  for (const entry of objects(value, "assessmentAcceptances"))
    add(acceptances, rowOf(entry, acceptances));
  const ancestry = objectAt(value, "sync_ancestry");
  if (ancestry) {
    const manifest = objectAt(ancestry, "base_manifest") ?? {};
    add(
      sync,
      yield* extras(rowOf(ancestry, sync, ["base_manifest"]), {
        base_manifest: Object.fromEntries(
          Object.entries(manifest).filter(
            ([key]) => !entities.some((entity) => entity.field === key) && key !== "enabled",
          ),
        ),
      }),
    );
    const syncRows = rows.get(sync.name);
    if (syncRows?.[0]) syncRows[0] = { ...syncRows[0], id: 1 };
    for (const difference of prepareManifestRows(value, manifest)) add(base, { ...difference });
  }
  return rows;
});

const assembleLibraryListing = Effect.fn("Library.assembleListing")(function* (
  rows: ReadonlyMap<string, readonly Row[]>,
) {
  const list = (table: Table) => rows.get(table.name) ?? [];
  const children = new Map<Table, Map<string | number | null | undefined, JsonObject[]>>();
  for (const table of [versions, members]) {
    const owner = table === versions ? "skill_id" : "collection_version_id";
    const groups = new Map<string | number | null | undefined, JsonObject[]>();
    for (const row of list(table)) {
      const existing = groups.get(row[owner]);
      const item = yield* objectOf(row, table);
      if (existing) existing.push(item);
      else groups.set(row[owner], [item]);
    }
    children.set(table, groups);
  }
  const first = list(device)[0];
  const value = first ? yield* objectOf(first, device) : {};
  for (const entity of entities)
    value[entity.field] = yield* Effect.forEach(list(entity.table), (row) =>
      Effect.gen(function* () {
        const item = yield* objectOf(row, entity.table);
        if (entity.table === skills)
          item.versions = children.get(versions)?.get(row.skill_id) ?? [];
        if (entity.table === collectionVersions)
          item.members = children.get(members)?.get(row.collection_version_id) ?? [];
        if (entity.table === imports)
          item.input = { value: row.input ?? "", ...objectAt(item, "input") };
        return item;
      }),
    );
  const owner = (scope: string, root: string, item: JsonObject) =>
    Effect.gen(function* () {
      item.enabled = yield* Effect.forEach(
        list(enabled).filter((row) => row.scope === scope && row.root === root),
        (row) => objectOf(row, enabled),
      );
      const entries = list(policies).filter((row) => row.scope === scope && row.root === root);
      if (entries.length || Object.hasOwn(item, "invocation_policies"))
        item.invocation_policies = {
          ...objectAt(item, "invocation_policies"),
          ...Object.fromEntries(entries.map((row) => [String(row.skill_id), row.policy])),
        };
      return item;
    });
  yield* owner("account", "", value);
  if (first?.device_skill_selection !== null && first?.device_skill_selection !== undefined) {
    const selection = {
      ...objectAt(value, "device_skill_selection"),
      mode: first.device_skill_selection,
    };
    value.device_skill_selection =
      selection.mode === "choose" ? yield* owner("device", "", selection) : selection;
  }
  value.repositories = yield* Effect.forEach(list(repositories), (row) =>
    Effect.gen(function* () {
      return yield* owner("repository", String(row.root), yield* objectOf(row, repositories));
    }),
  );
  value.installed_skills = yield* Effect.forEach(list(installed), (row) =>
    objectOf(row, installed),
  );
  return value;
});

const assembleLibraryRows = Effect.fn("Library.assembleRows")(function* (
  rows: ReadonlyMap<string, readonly Row[]>,
) {
  const list = (table: Table) => rows.get(table.name) ?? [];
  const value = yield* assembleLibraryListing(rows);
  if (Object.hasOwn(value, "assessmentAcceptances") || list(acceptances).length)
    value.assessmentAcceptances = yield* Effect.forEach(list(acceptances), (row) =>
      objectOf(row, acceptances),
    );
  const syncRow = list(sync)[0];
  if (syncRow) {
    const ancestry = yield* objectOf(syncRow, sync);
    const manifest = objectAt(ancestry, "base_manifest") ?? {};
    value.sync_ancestry = {
      ...ancestry,
      base_manifest: yield* readManifestRows(value, manifest, list(base)),
    };
  }
  return value;
});

/** Diff the supplied document base; the caller has checked it in this transaction. */
export const saveLibraryRows = Effect.fn("Library.saveRows")(function* (
  value: JsonObject,
  before: JsonObject | undefined,
) {
  yield* saveInventoryRows(
    yield* decodeInventoryScan(value),
    before ? yield* decodeInventoryScan(before) : undefined,
  );
  yield* saveRows(
    libraryTables,
    yield* splitLibraryRows(value),
    before ? yield* splitLibraryRows(before) : new Map(),
  );
});

const saveRows = Effect.fn("Library.saveChangedRows")(function* (
  tables: readonly Table[],
  rows: ReadonlyMap<string, readonly Row[]>,
  oldRows: ReadonlyMap<string, readonly Row[]>,
) {
  const sql = yield* SqlClient.SqlClient;
  const writes: Array<{
    table: Table;
    inserts: readonly Row[];
    updates: Array<{ before: Row; next: Row }>;
  }> = [];
  yield* sql`PRAGMA defer_foreign_keys = ON`;
  // Remove absent rows before updates and inserts can reuse their unique keys.
  for (const table of tables) {
    const next = rows.get(table.name) ?? [];
    const old = oldRows.get(table.name) ?? [];
    if (table.keys.length === 0) {
      if (JSON.stringify(old) !== JSON.stringify(next)) {
        yield* sql`DELETE FROM library_assessment_acceptances`;
        writes.push({ table, inserts: next, updates: [] });
      }
      continue;
    }
    // UNIQUE constraints are immediate: replacing the rows together permits valid path swaps.
    const unique =
      table === installed ? ["path"] : table === skills ? ["collection_id", "path"] : undefined;
    if (unique) {
      const owner = (row: Row) => JSON.stringify(table.keys.map((field) => row[field]));
      const value = (row: Row) => JSON.stringify(unique.map((field) => row[field]));
      const previous = new Map(old.map((row) => [value(row), owner(row)]));
      if (next.some((row) => previous.has(value(row)) && previous.get(value(row)) !== owner(row))) {
        yield* sql.unsafe(`DELETE FROM ${table.name}`);
        writes.push({ table, inserts: next, updates: [] });
        continue;
      }
    }
    const key = (row: Row) => JSON.stringify(table.keys.map((field) => row[field]));
    const difference = prepareRowDifference(old, next, key);
    if (
      difference.afterOrder &&
      table !== enabled &&
      table !== repositories &&
      table !== policies &&
      !catalogueTables.includes(table)
    ) {
      yield* sql.unsafe(`DELETE FROM ${table.name}`);
      writes.push({ table, inserts: next, updates: [] });
      continue;
    }
    const where = table.keys.map((column) => `${column} IS ?`).join(" AND ");
    const inserts: Row[] = [];
    const updates: Array<{ before: Row; next: Row }> = [];
    for (const change of difference.changes) {
      const before = change.before;
      if (change.after === undefined && before !== undefined)
        yield* sql.unsafe(
          `DELETE FROM ${table.name} WHERE ${where}`,
          table.keys.map((column) => before[column]),
        );
      else if (change.before === undefined && change.after !== undefined)
        inserts.push(change.after);
      else if (change.before !== undefined && change.after !== undefined)
        updates.push({ before: change.before, next: change.after });
    }
    writes.push({ table, inserts, updates });
  }
  for (const { table, inserts, updates } of writes) {
    const where = table.keys.map((column) => `${column} IS ?`).join(" AND ");
    for (const change of updates) {
      const columns = Object.keys(change.next).filter(
        (column) => change.next[column] !== change.before[column],
      );
      yield* sql.unsafe(
        `UPDATE ${table.name} SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE ${where}`,
        [
          ...columns.map((column) => change.next[column]),
          ...table.keys.map((column) => change.before[column]),
        ],
      );
    }
    for (const batch of EffectArray.chunksOf(inserts, 500)) {
      const [first, ...rest] = batch;
      if (first) yield* sql`INSERT INTO ${sql(table.name)} ${sql.insert([first, ...rest])}`;
    }
  }
});

const readRows = Effect.fn("Library.readRows")(function* (tables: readonly Table[]) {
  const sql = yield* SqlClient.SqlClient;
  const rows = new Map<string, readonly Row[]>();
  for (const table of tables) {
    const order = catalogueTables.includes(table)
      ? table.keys.join(",")
      : table === enabled || table === repositories || table === policies
        ? table.keys.join(",")
        : "rowid";
    rows.set(table.name, yield* sql.unsafe<Row>(`SELECT * FROM ${table.name} ORDER BY ${order}`));
  }
  return rows;
});

export const loadLibraryRows = Effect.fn("Library.loadRows")(function* (path: string) {
  const inventory = yield* loadInventoryRows(path).pipe(
    Effect.catchTag("SchemaError", (failure) =>
      Effect.fail(new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } })),
    ),
  );
  const rows = yield* readRows(libraryTables);
  const header = rows.get(device.name)?.[0];
  if (!header) {
    if (inventory !== undefined || [...rows.values()].some((list) => list.length))
      return yield* new InvalidLibraryState({
        path,
        reason: { _tag: "ContentMissing", entry: "library_device" },
      });
    return undefined;
  }
  const value = yield* assembleLibraryRows(rows).pipe(
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );
  Object.assign(value, inventory ?? {});
  return { value, revision: Number(header.revision) };
});

/** A listing reads catalogue and selections; it never reconstructs sync ancestry or scan state. */
export const loadLibraryListing = Effect.fn("Library.loadListing")(function* (path: string) {
  const rows = yield* readRows([
    collections,
    skills,
    versions,
    collectionVersions,
    members,
    imports,
    enabled,
    policies,
    repositories,
    installed,
    device,
  ]);
  if (!rows.get(device.name)?.length && [...rows.values()].some((list) => list.length))
    return yield* new InvalidLibraryState({
      path,
      reason: { _tag: "ContentMissing", entry: "library_device" },
    });
  return yield* assembleLibraryListing(rows).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.declare(
          Schema.is(
            Schema.Struct(
              Struct.pick(LibraryStateFields, [
                "collections",
                "skills",
                "collection_versions",
                "imports",
                "enabled",
                "repositories",
                "installed_skills",
                "device_skill_selection",
                "invocation_policies",
              ]),
            ),
          ),
        ),
      ),
    ),
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );
});

/** Read one installed folder, preserving fields the current release does not interpret. */
export const loadInstalledSkillRow = Effect.fn("Library.loadInstalledSkillRow")(function* (
  path: string,
  id: InstalledSkillId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql<Row>`SELECT * FROM library_installed_skills WHERE installed_skill_id=${id}`;
  if (!rows[0]) return undefined;
  return yield* objectOf(rows[0], installed).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.declare(Schema.is(InstalledSkill)))),
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );
});

/** The owning transaction has already checked the prior row and Library revision. */
export const saveInstalledSkillRow = Effect.fn("Library.saveInstalledSkillRow")(function* (
  path: string,
  id: InstalledSkillId,
  next: InstalledSkill | undefined,
  exists: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!next) {
    yield* sql`DELETE FROM library_installed_skills WHERE installed_skill_id=${id}`;
    return;
  }
  const value = yield* Schema.decodeUnknownEffect(JsonObject)(next).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.declare(Schema.is(InstalledSkill)))),
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );
  const document = yield* Schema.decodeUnknownEffect(JsonObject)(value).pipe(
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );
  const row = rowOf(document, installed);
  if (exists)
    yield* sql`UPDATE library_installed_skills SET ${sql.update(row)} WHERE installed_skill_id=${id}`;
  else yield* sql`INSERT INTO library_installed_skills ${sql.insert(row)}`;
});

/** These four tables suffice to read and change every enabled scope. */
export const loadEnabledRows = Effect.fn("Library.loadEnabledRows")(function* () {
  return yield* assembleLibraryListing(yield* readRows(enabledTables));
});

/** Keep the device header's other facts while replacing only named selection fields. */
export const saveEnabledRows = Effect.fn("Library.saveEnabledRows")(function* (
  current: JsonObject,
  next: JsonObject,
) {
  const fields = [
    "enabled",
    "invocation_policies",
    "repositories",
    "device_skill_selection",
    "pending_device_selection_origin",
  ];
  const desired = { ...current };
  for (const field of fields) {
    if (Object.hasOwn(next, field))
      Object.defineProperty(desired, field, {
        value: next[field],
        enumerable: true,
        configurable: true,
        writable: true,
      });
    else delete desired[field];
  }
  if (canonicalJson(current.enabled) !== canonicalJson(desired.enabled)) {
    const sql = yield* SqlClient.SqlClient;
    if ((yield* sql`SELECT id FROM library_sync WHERE id=1`).length) {
      const rows = yield* sql<{
        value: string;
      }>`SELECT value FROM library_sync_base WHERE entity='enabled' AND key=''`;
      const decode = Schema.Array(Schema.declare(Schema.is(Enabled)));
      const agreed = rows[0]
        ? yield* Schema.decodeEffect(Schema.fromJsonString(decode))(rows[0].value)
        : yield* Schema.decodeUnknownEffect(decode)(current.enabled);
      const after = [...(yield* Schema.decodeUnknownEffect(decode)(desired.enabled))].sort(
        (a, b) =>
          enabledItemKey(a) < enabledItemKey(b)
            ? -1
            : enabledItemKey(a) > enabledItemKey(b)
              ? 1
              : 0,
      );
      if (canonicalJson(agreed) === canonicalJson(after))
        yield* sql`DELETE FROM library_sync_base WHERE entity='enabled' AND key=''`;
      else
        yield* sql`INSERT INTO library_sync_base(entity,key,change,value) VALUES('enabled','','changed',${JSON.stringify(agreed)}) ON CONFLICT(entity,key) DO UPDATE SET change=excluded.change,value=excluded.value`;
    }
  }
  yield* saveRows(
    enabledTables,
    yield* splitEnabledRows(desired),
    yield* splitEnabledRows(current),
  );
});

/** Final Apply publication reads installed rows without loading the Library body. */
export const loadInstalledSkillRows = Effect.fn("Library.loadInstalledSkillRows")(function* (
  path: string,
) {
  const rows = yield* readRows([installed]);
  return yield* Effect.forEach(rows.get(installed.name) ?? [], (row) =>
    objectOf(row, installed),
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.Array(Schema.declare(Schema.is(InstalledSkill)))),
    ),
    Effect.mapError(
      (failure) => new InvalidLibraryState({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
  );
});

/** Bulk publication keeps explicit row order; ordinary final saves change only completed rows. */
export const saveInstalledSkillRows = Effect.fn("Library.saveInstalledSkillRows")(function* (
  next: readonly InstalledSkill[],
  base: readonly InstalledSkill[],
) {
  const encode = (items: readonly InstalledSkill[]) =>
    Effect.forEach(items, (item) =>
      Schema.decodeUnknownEffect(JsonObject)(item).pipe(
        Effect.map((document) => rowOf(document, installed)),
      ),
    );
  yield* saveRows(
    [installed],
    new Map([[installed.name, yield* encode(next)]]),
    new Map([[installed.name, yield* encode(base)]]),
  );
});

/** Catalogue facts have no dependency on folders, selections, scan results or accepted ancestry. */
export const loadCatalogueRows = Effect.fn("Library.loadCatalogueRows")(function* () {
  const value = yield* assembleLibraryListing(yield* readRows(catalogueTables));
  return Object.fromEntries(entities.map((entity) => [entity.field, value[entity.field]]));
});

export const saveCatalogueRows = Effect.fn("Library.saveCatalogueRows")(function* (
  next: JsonObject,
  base: JsonObject,
) {
  yield* saveRows(
    catalogueTables,
    yield* splitCatalogueRows(next),
    yield* splitCatalogueRows(base),
  );
});

/** Accepted ancestry depends on catalogue/account rows, never device folders or scan evidence. */
export const loadSyncAncestryRows = Effect.fn("Library.loadSyncAncestryRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* readRows([...catalogueTables, sync, base]);
  rows.set(
    enabled.name,
    yield* sql<Row>`SELECT * FROM library_enabled WHERE scope='account' AND root='' ORDER BY item_key`,
  );
  const local = yield* assembleLibraryListing(rows);
  const header = rows.get(sync.name)?.[0];
  if (!header) return { local, ancestry: undefined };
  const ancestry = yield* objectOf(header, sync);
  ancestry.base_manifest = yield* readManifestRows(
    local,
    objectAt(ancestry, "base_manifest") ?? {},
    rows.get(base.name) ?? [],
  );
  return { local, ancestry };
});

/** Save only the accepted head and its differences from the current portable rows. */
export const saveSyncAncestryRows = Effect.fn("Library.saveSyncAncestryRows")(function* (
  local: JsonObject,
  ancestry: JsonObject,
) {
  const manifest = objectAt(ancestry, "base_manifest") ?? {};
  const header = yield* extras(rowOf(ancestry, sync, ["base_manifest"]), {
    base_manifest: Object.fromEntries(
      Object.entries(manifest).filter(
        ([key]) => !entities.some((entity) => entity.field === key) && key !== "enabled",
      ),
    ),
  });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO library_sync ${sql.insert({ ...header, id: 1 })} ON CONFLICT(id) DO UPDATE SET origin=excluded.origin,library_id=excluded.library_id,revision_id=excluded.revision_id,extra=excluded.extra`;
  yield* sql`DELETE FROM library_sync_base`;
  for (const row of prepareManifestRows(local, manifest))
    yield* sql`INSERT INTO library_sync_base ${sql.insert(row)}`;
});

/** Security acceptance is an insert-only fact with preserved, uninterpreted extension fields. */
export const insertAcceptanceRow = Effect.fn("Library.insertAcceptanceRow")(function* (
  value: JsonObject,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO library_assessment_acceptances ${sql.insert(rowOf(value, acceptances))}`;
});
