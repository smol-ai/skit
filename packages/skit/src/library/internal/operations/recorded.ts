import { DateTime, Effect, Schema } from "effect";
import * as InstalledSkills from "../../installed-skills.js";
import * as Status from "../../installed-skill-status.js";
import { makeInstalledSkillId, type OperationId } from "../../entity-ids.js";
import { reviewApply } from "./review.js";
import { InvalidIntent } from "../../enabled-plan.js";
import { StalePlan, type Plan } from "../../library-plan.js";
import {
  libraryStateRevision,
  type LibraryState,
  type InstalledSkill,
} from "../../library-state.js";
import { OperationStatus } from "../../store/state-schema.js";
import { LibraryWriter, loadLibrary, libraryOriginalsPath } from "../../store/library-store.js";
import { stepRouting } from "../../routing/step.js";
import type { Routing } from "../../library.js";
import { compileApply, finalRows, type ApplyStep } from "./program.js";
export type { ApplyStep } from "./program.js";

/** Revalidate once, then fix every row and byte expectation before creating skills directories. */
export const prepareApply = Effect.fn("Library.prepareRecordedApply")(function* (
  home: string,
  plan: Plan,
  configuration: Routing,
) {
  const { input, base, again, snapshot } = yield* reviewApply(home, plan);
  const files = yield* InstalledSkills.Service;
  const installedAt = DateTime.formatIso(yield* DateTime.now);
  const rows = new Map<string, InstalledSkill>();
  let invalidSource: { readonly path: string; readonly reason: string } | undefined;
  for (const change of again.changes) {
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
          : Status.suppressed(change.recorded, installedAt),
      );
      continue;
    }
    if (
      change._tag === "Unchanged" &&
      change.recorded?.status === "installed" &&
      change.recorded.skill_version_id === change.skillVersionId &&
      change.recorded.expected_hash === change.hash &&
      change.recorded.root === change.root &&
      change.recorded.path === change.path &&
      change.recorded.destination === change.destination
    ) {
      rows.set(change.path, change.recorded);
      continue;
    }
    let hash;
    if (change._tag === "Install" || change._tag === "Manage" || change._tag === "Update") {
      const built = yield* Effect.result(
        files.build(change, again.next, libraryOriginalsPath(home)),
      );
      if (built._tag === "Failure") {
        if (built.failure._tag !== "Library.InstalledSkillInvalid")
          return yield* Effect.fail(built.failure);
        invalidSource = { path: change.path, reason: built.failure.detail };
        break;
      }
      hash = built.success.hash;
    } else hash = change.hash;
    if (change._tag !== "Install" && hash !== change.hash)
      return yield* new StalePlan({
        message: `Reviewed installed bytes changed at ${change.path}`,
      });
    const pending: InstalledSkill = {
      installed_skill_id: change.recorded?.installed_skill_id ?? makeInstalledSkillId(),
      skill_id: change.skillId,
      skill_version_id: change.skillVersionId,
      destination: change.destination,
      root: change.root,
      path: change.path,
      expected_hash: hash,
      status: "pending",
      installed_at: installedAt,
    };
    rows.set(
      change.path,
      change._tag === "Conflict"
        ? Status.conflicted(pending, change.currentHash, change.expectedHash)
        : Status.installed(pending),
    );
  }
  const routing =
    configuration._tag === "Configured"
      ? yield* stepRouting(configuration, again.next)
      : {
          active: configuration._tag === "None" ? [] : yield* files.active,
          destinations: input.routes.flatMap(({ scope, destinations }) =>
            destinations.map((target) => ({ scope, ...target })),
          ),
          readable: [],
        };
  const reviewed = { ...input, next: again.next };
  const compiled = yield* compileApply(
    invalidSource
      ? {
          ...reviewed,
          changes: input.changes.filter(
            (change) => change._tag === "Enable" || change._tag === "Disable",
          ),
        }
      : reviewed,
    base,
    rows,
    routing,
  );
  const { installed_skills: _rows, operations: _operations, ...unchanged } = base;
  const step: ApplyStep = invalidSource
    ? { ...compiled, next: unchanged, save: "after", changes: [{ _tag: "Fail", ...invalidSource }] }
    : compiled;
  let noop =
    libraryStateRevision({
      ...step.next,
      installed_skills: finalRows(step),
      operations: base.operations,
    }) === libraryStateRevision(base) &&
    step.changes.every((change) => change._tag === "Save" && !change.backUp);
  if (noop)
    for (const row of base.installed_skills)
      if ((yield* files.backups.scan(row.root, row.installed_skill_id)).length) {
        noop = false;
        break;
      }
  return { step, snapshot, noop };
});

/** State and progress use the same atomic state-file replacement. */
export const saveStep = Effect.fn("Library.saveApplyStep")(function* (
  operationId: OperationId,
  index: number,
  step: ApplyStep,
  batch?: string,
  next?: LibraryState,
  base?: LibraryState,
) {
  const writer = yield* LibraryWriter;
  const current = base ?? (yield* loadLibrary(writer.home));
  const state = next ?? current;
  const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
    state.operations,
  ).pipe(
    Effect.mapError(() => new InvalidIntent({ detail: "Invalid recorded Library operation" })),
  );
  const operation = operations.find((item) => item.operationId === operationId);
  if (operation?._tag !== "Pending" || !operation.steps[index])
    return yield* new InvalidIntent({
      detail: "Installed changes require their Pending operation",
    });
  const encoded = yield* Schema.encodeEffect(OperationStatus)({
    ...operation,
    steps: operation.steps.map((item, at) =>
      at !== index
        ? item
        : batch === undefined
          ? { ...item, step }
          : {
              ...item,
              applies: [
                ...(item.applies ?? []).filter((item) => item.key !== batch),
                { key: batch, apply: step },
              ],
            },
    ),
  }).pipe(Effect.mapError(() => new InvalidIntent({ detail: "Invalid installed-change record" })));
  yield* writer.save(
    {
      ...state,
      operations: state.operations.map((item) =>
        item.operationId === operationId ? encoded : item,
      ),
    },
    current,
  );
});
