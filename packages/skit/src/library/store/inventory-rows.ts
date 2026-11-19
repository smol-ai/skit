import { Effect, Schema, Struct } from "effect";
import { SqlClient } from "effect/sql";
import { LibraryStateFields } from "./state-fields.js";
import { canonicalJson, JsonObject } from "../../shared/json.js";
import { InvalidLibraryState } from "../failures.js";

const fields = ["unmanaged", "ownershipIssues", "scanIssues"] as const;
const InventoryScanFields = Schema.Struct(Struct.pick(LibraryStateFields, fields));
export type InventoryScan = typeof InventoryScanFields.Type;
const InventoryScan = Schema.declare(Schema.is(InventoryScanFields));

/** Decode only scan results; refining keeps every uninterpreted child field intact. */
export const decodeInventoryScan = Effect.fn("Inventory.decodeScan")(function* (input: unknown) {
  const document = yield* Schema.decodeUnknownEffect(JsonObject)(input);
  return yield* Schema.decodeUnknownEffect(InventoryScan)(Struct.pick(document, fields));
});

const extra = (value: JsonObject, known: readonly string[]) => {
  const kept = Object.fromEntries(Object.entries(value).filter(([key]) => !known.includes(key)));
  return Object.keys(kept).length ? JSON.stringify(kept) : null;
};
const readExtra = (value: unknown) =>
  value === null || value === undefined
    ? Effect.succeed<JsonObject>({})
    : Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))(value);

/** Duplicate scan results and child values retain their positions. */
const createInventoryTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE library_inventory (
    id INTEGER PRIMARY KEY CHECK(id=1),
    ownership_issues_present INTEGER NOT NULL CHECK(ownership_issues_present IN (0,1)),
    scan_issues_present INTEGER NOT NULL CHECK(scan_issues_present IN (0,1))
  ) STRICT`;
  yield* sql`CREATE TABLE library_unmanaged_skills (
    position INTEGER PRIMARY KEY CHECK(position>=0),harness TEXT NOT NULL,path TEXT NOT NULL,
    current_hash TEXT NOT NULL,last_hash TEXT,
    paths_present INTEGER NOT NULL CHECK(paths_present IN (0,1)),
    harnesses_present INTEGER NOT NULL CHECK(harnesses_present IN (0,1)),
    extra TEXT CHECK(extra IS NULL OR json_valid(extra))
  ) STRICT`;
  yield* sql`CREATE TABLE library_unmanaged_paths (
    unmanaged_position INTEGER NOT NULL REFERENCES library_unmanaged_skills(position) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position>=0),path TEXT NOT NULL,
    PRIMARY KEY(unmanaged_position,position)
  ) STRICT`;
  yield* sql`CREATE TABLE library_unmanaged_harnesses (
    unmanaged_position INTEGER NOT NULL REFERENCES library_unmanaged_skills(position) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position>=0),harness TEXT NOT NULL,
    PRIMARY KEY(unmanaged_position,position)
  ) STRICT`;
  yield* sql`CREATE TABLE library_ownership_issues (
    position INTEGER PRIMARY KEY CHECK(position>=0),code TEXT NOT NULL,path TEXT NOT NULL,
    canonical_path TEXT NOT NULL,current_hash TEXT NOT NULL,
    marker_reason TEXT CHECK(marker_reason IS NULL OR json_valid(marker_reason)),
    collection_id TEXT,skill_id TEXT,installed_skill_id TEXT,expected_hash TEXT,
    matches_expected_hash INTEGER CHECK(matches_expected_hash IS NULL OR matches_expected_hash IN (0,1)),
    extra TEXT CHECK(extra IS NULL OR json_valid(extra))
  ) STRICT`;
  yield* sql`CREATE TABLE library_ownership_issue_harnesses (
    issue_position INTEGER NOT NULL REFERENCES library_ownership_issues(position) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position>=0),harness TEXT NOT NULL,
    PRIMARY KEY(issue_position,position)
  ) STRICT`;
  yield* sql`CREATE TABLE library_scan_issues (
    position INTEGER PRIMARY KEY CHECK(position>=0),code TEXT NOT NULL,path TEXT NOT NULL,
    harness TEXT NOT NULL,target TEXT,extra TEXT CHECK(extra IS NULL OR json_valid(extra))
  ) STRICT`;
});

/** Refresh replaces this cache alone; unchanged results do not cause database writes. */
export const saveInventoryRows = Effect.fn("Inventory.saveRows")(function* (
  next: InventoryScan,
  base?: InventoryScan,
) {
  if (base !== undefined && canonicalJson(next) === canonicalJson(base)) return false;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM library_unmanaged_skills`;
  yield* sql`DELETE FROM library_ownership_issues`;
  yield* sql`DELETE FROM library_scan_issues`;
  const header = {
    id: 1,
    ownership_issues_present: Object.hasOwn(next, "ownershipIssues") ? 1 : 0,
    scan_issues_present: Object.hasOwn(next, "scanIssues") ? 1 : 0,
  };
  yield* sql`INSERT INTO library_inventory ${sql.insert(header)} ON CONFLICT(id) DO UPDATE SET ownership_issues_present=excluded.ownership_issues_present,scan_issues_present=excluded.scan_issues_present`;
  for (const [position, item] of next.unmanaged.entries()) {
    const value = yield* Schema.decodeUnknownEffect(JsonObject)(item);
    yield* sql`INSERT INTO library_unmanaged_skills ${sql.insert({
      position,
      harness: item.harness,
      path: item.path,
      current_hash: item.currentHash,
      last_hash: item.lastHash ?? null,
      paths_present: Object.hasOwn(item, "paths") ? 1 : 0,
      harnesses_present: Object.hasOwn(item, "harnesses") ? 1 : 0,
      extra: extra(value, ["harness", "path", "currentHash", "lastHash", "paths", "harnesses"]),
    })}`;
    for (const [at, path] of (item.paths ?? []).entries())
      yield* sql`INSERT INTO library_unmanaged_paths ${sql.insert({ unmanaged_position: position, position: at, path })}`;
    for (const [at, harness] of (item.harnesses ?? []).entries())
      yield* sql`INSERT INTO library_unmanaged_harnesses ${sql.insert({ unmanaged_position: position, position: at, harness })}`;
  }
  for (const [position, item] of (next.ownershipIssues ?? []).entries()) {
    const value = yield* Schema.decodeUnknownEffect(JsonObject)(item);
    yield* sql`INSERT INTO library_ownership_issues ${sql.insert({
      position,
      code: item.code,
      path: item.path,
      canonical_path: item.canonicalPath,
      current_hash: item.currentHash,
      // Marker diagnostics are one structured piece of evidence, not a separate mutable entity.
      marker_reason: item.markerReason === undefined ? null : JSON.stringify(item.markerReason),
      collection_id: item.collectionId ?? null,
      skill_id: item.skillId ?? null,
      installed_skill_id: item.installedSkillId ?? null,
      expected_hash: item.expectedHash ?? null,
      matches_expected_hash:
        item.matchesExpectedHash === undefined ? null : item.matchesExpectedHash ? 1 : 0,
      extra: extra(value, [
        "code",
        "path",
        "canonicalPath",
        "currentHash",
        "markerReason",
        "collectionId",
        "skillId",
        "installedSkillId",
        "expectedHash",
        "matchesExpectedHash",
        "harnesses",
      ]),
    })}`;
    for (const [at, harness] of item.harnesses.entries())
      yield* sql`INSERT INTO library_ownership_issue_harnesses ${sql.insert({ issue_position: position, position: at, harness })}`;
  }
  for (const [position, item] of (next.scanIssues ?? []).entries()) {
    const value = yield* Schema.decodeUnknownEffect(JsonObject)(item);
    yield* sql`INSERT INTO library_scan_issues ${sql.insert({
      position,
      code: item.code,
      path: item.path,
      harness: item.harness,
      target: item.code === "DANGLING_SYMLINK" ? item.target : null,
      extra: extra(value, [
        "code",
        "path",
        "harness",
        ...(item.code === "DANGLING_SYMLINK" ? ["target"] : []),
      ]),
    })}`;
  }
  return true;
});

type Row = Record<string, string | number | null>;
const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Flag = Schema.Literals([0, 1]);

/** Reconstruct scan only, validating positions and flags before any child can be ignored. */
export const loadInventoryRows = Effect.fn("Inventory.loadRows")(function* (path: string) {
  const sql = yield* SqlClient.SqlClient;
  const headers = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        id: Schema.Literal(1),
        ownership_issues_present: Flag,
        scan_issues_present: Flag,
      }),
    ),
  )(yield* sql`SELECT * FROM library_inventory ORDER BY id`);
  const unmanaged = yield* sql<Row>`SELECT * FROM library_unmanaged_skills ORDER BY position`;
  const paths =
    yield* sql<Row>`SELECT * FROM library_unmanaged_paths ORDER BY unmanaged_position,position`;
  const harnesses =
    yield* sql<Row>`SELECT * FROM library_unmanaged_harnesses ORDER BY unmanaged_position,position`;
  const ownership = yield* sql<Row>`SELECT * FROM library_ownership_issues ORDER BY position`;
  const issueHarnesses =
    yield* sql<Row>`SELECT * FROM library_ownership_issue_harnesses ORDER BY issue_position,position`;
  const issues = yield* sql<Row>`SELECT * FROM library_scan_issues ORDER BY position`;
  const header = headers[0];
  const invalid = () =>
    new InvalidLibraryState({
      path,
      reason: {
        _tag: "InvalidData",
        issue: "Inventory scan positions or presence do not match their child rows",
      },
    });
  if (!header) {
    if (
      [unmanaged, paths, harnesses, ownership, issueHarnesses, issues].some((rows) => rows.length)
    )
      return yield* invalid();
    return undefined;
  }
  yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({ position: Position, paths_present: Flag, harnesses_present: Flag }),
    ),
  )(unmanaged);
  yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ position: Position })))(ownership);
  yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ position: Position })))(issues);
  const unmanagedPositions = new Set(unmanaged.map((row) => row.position));
  const ownershipPositions = new Set(ownership.map((row) => row.position));
  if (
    [unmanaged, ownership, issues].some((rows) =>
      rows.some((row, index) => row.position !== index),
    ) ||
    paths.some((row) => !unmanagedPositions.has(row.unmanaged_position)) ||
    harnesses.some((row) => !unmanagedPositions.has(row.unmanaged_position)) ||
    issueHarnesses.some((row) => !ownershipPositions.has(row.issue_position)) ||
    (!header.ownership_issues_present && ownership.length) ||
    (!header.scan_issues_present && issues.length)
  )
    return yield* invalid();
  const value: JsonObject = { unmanaged: [] };
  for (const row of unmanaged) {
    const aliases = paths.filter((child) => child.unmanaged_position === row.position);
    const names = harnesses.filter((child) => child.unmanaged_position === row.position);
    if (
      (!row.paths_present && aliases.length) ||
      (!row.harnesses_present && names.length) ||
      aliases.some((child, index) => child.position !== index) ||
      names.some((child, index) => child.position !== index)
    )
      return yield* invalid();
    const item: JsonObject = {
      ...(yield* readExtra(row.extra)),
      harness: row.harness,
      path: row.path,
      currentHash: row.current_hash,
      ...(row.last_hash === null ? {} : { lastHash: row.last_hash }),
      ...(row.paths_present ? { paths: aliases.map((child) => child.path) } : {}),
      ...(row.harnesses_present ? { harnesses: names.map((child) => child.harness) } : {}),
    };
    if (Array.isArray(value.unmanaged)) value.unmanaged.push(item);
  }
  if (header.ownership_issues_present) {
    value.ownershipIssues = [];
    for (const row of ownership) {
      const names = issueHarnesses.filter((child) => child.issue_position === row.position);
      if (names.some((child, index) => child.position !== index)) return yield* invalid();
      const item: JsonObject = {
        ...(yield* readExtra(row.extra)),
        code: row.code,
        path: row.path,
        canonicalPath: row.canonical_path,
        currentHash: row.current_hash,
        harnesses: names.map((child) => child.harness),
      };
      for (const [column, field] of [
        ["collection_id", "collectionId"],
        ["skill_id", "skillId"],
        ["installed_skill_id", "installedSkillId"],
        ["expected_hash", "expectedHash"],
      ])
        if (row[column] !== null) item[field] = row[column];
      if (row.marker_reason !== null)
        item.markerReason = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.MutableJson),
        )(row.marker_reason);
      if (row.matches_expected_hash !== null) {
        const flag = yield* Schema.decodeUnknownEffect(Flag)(row.matches_expected_hash);
        item.matchesExpectedHash = flag === 1;
      }
      if (Array.isArray(value.ownershipIssues)) value.ownershipIssues.push(item);
    }
  }
  if (header.scan_issues_present) {
    value.scanIssues = [];
    for (const row of issues) {
      const item = {
        ...(yield* readExtra(row.extra)),
        code: row.code,
        path: row.path,
        harness: row.harness,
        ...(row.target === null ? {} : { target: row.target }),
      };
      if (Array.isArray(value.scanIssues)) value.scanIssues.push(item);
    }
  }
  return yield* decodeInventoryScan(value);
});

/** Migration owns one short transaction: validate all old values before replacing their layout. */
export const migrateInventoryRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        id: Schema.Literal(1),
        unmanaged: Schema.NullOr(Schema.String),
        ownership_issues: Schema.NullOr(Schema.String),
        scan_issues: Schema.NullOr(Schema.String),
      }),
    ),
  )(yield* sql`SELECT * FROM library_inventory ORDER BY id`);
  const row = rows[0];
  let scan: InventoryScan | undefined;
  if (row) {
    const value: JsonObject = {};
    for (const [field, column] of [
      ["unmanaged", "unmanaged"],
      ["ownershipIssues", "ownership_issues"],
      ["scanIssues", "scan_issues"],
    ]) {
      const text =
        column === "unmanaged"
          ? row.unmanaged
          : column === "ownership_issues"
            ? row.ownership_issues
            : row.scan_issues;
      if (text !== null)
        value[field] = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.MutableJson))(
          text,
        );
    }
    scan = yield* decodeInventoryScan(value);
  }
  yield* sql`DROP TABLE library_inventory`;
  yield* createInventoryTables;
  if (scan) yield* saveInventoryRows(scan);
});
