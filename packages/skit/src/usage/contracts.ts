import { Schema } from "effect";

export const UsageHarness = Schema.Literals(["codex", "claude-code"]);
export type UsageHarness = typeof UsageHarness.Type;
export const UsageKind = Schema.Literals(["calls", "loads", "reads"]);
export type UsageKind = typeof UsageKind.Type;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const UsageRow = Schema.Struct({
  name: Schema.String,
  harness: UsageHarness,
  path: Schema.NullOr(Schema.String),
  skillId: Schema.NullOr(Schema.String),
  identity: Schema.Literals(["managed", "unmanaged", "name-only", "unresolved", "ambiguous"]),
  calls: Count,
  loads: Count,
  reads: Count,
  lastObservedAt: Schema.String,
});
export interface UsageRow extends Schema.Schema.Type<typeof UsageRow> {}
export const UsageCoverage = Schema.Struct({
  harness: UsageHarness,
  root: Schema.String,
  status: Schema.Literals(["available", "missing", "unreadable"]),
  files: Count,
  bytes: Count,
  bytesRead: Count,
  records: Count,
  windowRecords: Count,
  malformed: Count,
  undated: Count,
  undatedCandidates: Count,
  unsupported: Count,
  duplicates: Count,
  missingIds: Count,
  summaries: Count,
  mentions: Count,
  slashCommands: Count,
  oversizedLines: Count,
  skippedFiles: Count,
  unreadableFiles: Count,
  changedFiles: Count,
  unknownProjectRecords: Count,
});
export interface UsageCoverage extends Schema.Schema.Type<typeof UsageCoverage> {}
export const UsageReport = Schema.Struct({
  window: Schema.Struct({ start: Schema.String, end: Schema.String }),
  project: Schema.NullOr(Schema.String),
  rows: Schema.Array(UsageRow),
  coverage: Schema.Array(UsageCoverage),
  incomplete: Schema.Boolean,
  durationMs: Schema.Number,
});
export interface UsageReport extends Schema.Schema.Type<typeof UsageReport> {}
export class InvalidUsageOptions extends Schema.TaggedError<InvalidUsageOptions>()(
  "InvalidUsageOptions",
  {
    message: Schema.String,
  },
) {}
export interface UsageRoot {
  readonly harness: UsageHarness;
  readonly root: string;
}
export interface UsageProjection {
  readonly path: string;
  readonly skillId: string;
  readonly name: string;
}
export interface UsageOptions {
  readonly roots: readonly UsageRoot[];
  readonly days?: number;
  readonly end?: string;
  readonly project?: string;
  readonly projections?: readonly UsageProjection[];
  readonly progress?: (completed: number, total: number) => import("effect").Effect.Effect<void>;
}
