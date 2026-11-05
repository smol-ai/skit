import { Effect, Option, Schema } from "effect";
import { InvalidIntent } from "../enabled-plan.js";
import { Plan } from "../library-plan.js";
import { InstalledSkill } from "../device-state.js";
import * as Status from "../installed-skill-status.js";
import { InstalledSkillId, OperationId } from "../entity-ids.js";
import { Hash } from "../../vocabulary.js";
import { LibraryState } from "../library-state.js";
import { recordedLibrary } from "../setup-intent.js";
import { compileApply, finalRows, same } from "../internal/operations/program.js";
import {
  LibraryStateFields,
  SetupStep,
  StepRouting,
  SyncFolder,
  SyncAncestry,
  StepEvidence,
  RecordedLibrary,
  SetupStopReason,
  OperationStatus,
} from "./state-schema.js";

// Frozen v12 publications and Apply documents. Only the state loader imports this module.
const V12Publication = Schema.Struct({ ...LibraryStateFields, schemaVersion: Schema.Literal(12) });
const V12Apply = Schema.TaggedStruct("Apply", {
  reviewed: Schema.Json,
  before: V12Publication,
  routing: StepRouting,
  installedAt: Schema.String,
  ids: Schema.Array(Schema.Struct({ path: Schema.String, id: InstalledSkillId })),
  expected: Schema.Array(InstalledSkill),
  prepared: Schema.Boolean,
  completed: Schema.OptionFromOptionalKey(
    Schema.Struct({ state: V12Publication, folders: Schema.Array(SyncFolder) }),
  ),
});
const V12Sync = Schema.TaggedStruct("Sync", {
  phase: Schema.Literal("retire"),
  program: Schema.Struct({
    before: V12Publication,
    after: V12Publication,
    routing: StepRouting,
    retire: Schema.Array(InstalledSkill),
    drop: Schema.Array(InstalledSkillId),
    manifestDigest: Hash,
    receipt: Schema.OptionFromOptionalKey(SyncAncestry),
    folders: Schema.Array(SyncFolder),
    issues: Schema.Array(Schema.String),
  }),
});
// All remaining step variants have unchanged storage fields (publish/install Sync starts at index 5).
const V12Step = Schema.Union([V12Apply, V12Sync, ...SetupStep.members.slice(5)]);
const V12RecordedStep = Schema.Struct({
  step: V12Step,
  applies: Schema.optionalKey(Schema.Array(Schema.Struct({ key: Schema.String, apply: V12Apply }))),
  before: Schema.Array(StepEvidence),
  after: Schema.Array(StepEvidence),
  status: Schema.Literals(["Pending", "Done"]),
});
const V12Operation = Schema.TaggedUnion({
  Pending: {
    operationId: OperationId,
    steps: Schema.Array(V12RecordedStep),
    before: RecordedLibrary,
  },
  Done: {
    operationId: OperationId,
    steps: Schema.Array(V12RecordedStep),
    before: RecordedLibrary,
    after: RecordedLibrary,
  },
  Stopped: {
    operationId: OperationId,
    steps: Schema.Array(V12RecordedStep),
    before: RecordedLibrary,
    after: RecordedLibrary,
    reason: SetupStopReason,
  },
});
const V12State = Schema.Struct({ ...V12Publication.fields, operations: Schema.Array(Schema.Json) });
const LegacyPlanDocument = Schema.Record(Schema.String, Schema.Json);

const migrateApply = Effect.fn("Library.migrateV12Apply")(function* (old: typeof V12Apply.Type) {
  const document = yield* Schema.decodeUnknownEffect(LegacyPlanDocument)(old.reviewed);
  const next = yield* Schema.decodeUnknownEffect(V12State)(document.next);
  if (next.operations.length)
    return yield* new InvalidIntent({ detail: "Legacy Apply embeds operation history" });
  const plan = yield* Schema.decodeUnknownEffect(Plan)({
    ...document,
    next: { ...next, schemaVersion: 13 },
  });
  const before: LibraryState = { ...old.before, schemaVersion: 13, operations: [] };
  const rows = new Map<string, InstalledSkill>();
  for (const change of plan.changes) {
    if (
      !("skillVersionId" in change) ||
      change._tag === "Protected" ||
      change._tag === "Unreadable"
    )
      continue;
    if (change._tag === "KeepDeleted") {
      rows.set(
        change.path,
        change.recorded.status === "suppressed"
          ? change.recorded
          : Status.suppressed(change.recorded, old.installedAt),
      );
      continue;
    }
    const id = old.ids.find((item) => item.path === change.path)?.id;
    const expected = old.expected.find((row) => row.path === change.path);
    if (
      !id ||
      (expected &&
        (expected.installed_skill_id !== id ||
          expected.skill_id !== change.skillId ||
          expected.skill_version_id !== change.skillVersionId))
    )
      return yield* new InvalidIntent({
        detail: `Legacy Apply has inconsistent installed identity at ${change.path}`,
      });
    const hash = change._tag === "Install" ? expected?.expected_hash : change.hash;
    if (!hash)
      return yield* new InvalidIntent({
        detail: `Legacy Apply has no recorded install hash at ${change.path}; review and apply again`,
      });
    const row: InstalledSkill = {
      installed_skill_id: id,
      skill_id: change.skillId,
      skill_version_id: change.skillVersionId,
      destination: change.destination,
      root: change.root,
      path: change.path,
      expected_hash: hash,
      installed_at: old.installedAt,
      status: "pending",
    };
    const canonical =
      change._tag === "Conflict"
        ? Status.conflicted(row, change.currentHash, change.expectedHash)
        : Status.installed(row);
    if (old.prepared && (!expected || !same(expected, canonical)))
      return yield* new InvalidIntent({
        detail: `Legacy Apply has inconsistent prepared row at ${change.path}`,
      });
    rows.set(change.path, canonical);
  }
  const step = yield* compileApply(plan, before, rows, old.routing);
  if (Option.isSome(old.completed)) {
    const final = { ...step.next, installed_skills: finalRows(step) };
    if (!same(final, { ...old.completed.value.state, schemaVersion: 13 }))
      return yield* new InvalidIntent({
        detail: "Legacy Apply completion differs from its recorded changes",
      });
    return { ...step, phase: { _tag: "Done" as const, folders: old.completed.value.folders } };
  }
  return step;
});

const migrateStep = Effect.fn("Library.migrateV12Step")(function* (
  old: typeof V12RecordedStep.Type,
) {
  const attempt = yield* Effect.result(
    Effect.gen(function* () {
      const adapter =
        old.step._tag === "Manage" ||
        old.step._tag === "Update" ||
        (old.step._tag === "Sync" && old.step.phase !== "publish");
      if (old.status === "Pending" && adapter && !old.applies?.length)
        return yield* new InvalidIntent({
          detail: "Legacy pending step has no recorded installed changes; review and apply again",
        });
      const step =
        old.step._tag === "Apply" && "reviewed" in old.step
          ? yield* migrateApply(old.step)
          : old.step._tag === "Sync" && old.step.phase === "retire"
            ? {
                ...old.step,
                program: {
                  ...old.step.program,
                  before: { ...old.step.program.before, schemaVersion: 13 as const },
                  after: { ...old.step.program.after, schemaVersion: 13 as const },
                },
              }
            : old.step;
      const applies = old.applies
        ? yield* Effect.forEach(old.applies, (batch) =>
            Effect.map(migrateApply(batch.apply), (apply) => ({ key: batch.key, apply })),
          )
        : undefined;
      const { applies: _applies, ...recorded } = old;
      return { ...recorded, step, ...(applies ? { applies } : {}) };
    }),
  );
  if (attempt._tag === "Success") return attempt.success;
  const document = yield* Schema.encodeEffect(V12RecordedStep)(old).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
  );
  return {
    step: {
      _tag: "LegacyApply" as const,
      document,
      detail: `Cannot safely migrate recorded installed changes: ${attempt.failure.message}`,
    },
    before: old.before,
    after: old.after,
    status: old.status,
  };
});

/** Conversion is data-only. No staging, replanning, folder creation or installed-row repair. */
export const migrateLibraryStateV12 = Effect.fn("Library.migrateStateV12")(function* (
  value: unknown,
) {
  const old = yield* Schema.decodeUnknownEffect(V12State)(value);
  const current: LibraryState = { ...old, schemaVersion: 13, operations: [] };
  const operations = yield* Effect.forEach(old.operations, (document) =>
    Effect.gen(function* () {
      const operation = yield* Schema.decodeUnknownEffect(V12Operation)(document);
      const steps = yield* Effect.forEach(operation.steps, migrateStep);
      const blocked = steps.findIndex((item) => item.step._tag === "LegacyApply");
      if (blocked < 0) return yield* Schema.encodeEffect(OperationStatus)({ ...operation, steps });
      const step = steps[blocked]?.step;
      return yield* Schema.encodeEffect(OperationStatus)({
        _tag: "Stopped",
        operationId: operation.operationId,
        steps,
        before: operation.before,
        after: operation._tag === "Pending" ? recordedLibrary(current) : operation.after,
        reason: {
          _tag: "StepFailed",
          step: blocked,
          error: {
            _tag: "Library.ApplyMigrationStopped",
            code: "CONFLICT",
            message:
              step?._tag === "LegacyApply"
                ? step.detail
                : "Legacy installed changes require review",
            remediation: "Review and apply the change again.",
          },
        },
      });
    }),
  );
  return yield* LibraryState.makeEffect({ ...current, operations });
});
