import { DateTime, Effect, Option, Schema } from "effect";
import { canonicalJson } from "../../../shared/json.js";
import { InstalledSkills } from "../../installed-skills.js";
import * as Status from "../../installed-skill-status.js";
import { makeInstalledSkillId, type OperationId } from "../../entity-ids.js";
import { reviewApply } from "./review.js";
import { InvalidIntent } from "../../enabled-plan.js";
import { Plan } from "../../library-plan.js";
import {
  libraryStateRevision,
  type LibraryState,
  type InstalledSkill,
} from "../../library-state.js";
import { OperationStatus, type SetupStep, type SyncPublication } from "../../store/state-schema.js";
import {
  LibraryWriter,
  loadLibrary,
  libraryStatePath,
  libraryOriginalsPath,
} from "../../store/library-store.js";
import { snapshotOf } from "../../snapshot.js";
import { stepRouting } from "../../routing/step.js";
import type { Routing } from "../../library.js";

export type ApplyStep = Extract<SetupStep, { readonly _tag: "Apply" }>;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const publication = ({ operations: _operations, ...state }: LibraryState): SyncPublication => state;
const body = ({ installed_skills: _copies, ...state }: SyncPublication) => state;
const invalid = () => new InvalidIntent({ detail: "Invalid recorded Library apply" });
export const reviewedApply = (step: ApplyStep) =>
  Schema.decodeUnknownEffect(Plan)(step.reviewed).pipe(Effect.mapError(invalid));

/** Revalidate before recording anything. No skill root or Library file is created here. */
export const prepareApply = Effect.fn("Library.prepareRecordedApply")(function* (
  home: string,
  plan: Plan,
  configuration: Routing,
) {
  const { input, base, again, snapshot } = yield* reviewApply(home, plan);
  const files = yield* InstalledSkills.Service;
  let noop =
    libraryStateRevision(again.next) === libraryStateRevision(base) &&
    again.changes.every(
      (change) =>
        change._tag === "Protected" ||
        (change._tag === "KeepDeleted" && change.recorded.status === "suppressed") ||
        (change._tag === "Unchanged" &&
          change.recorded?.status === "installed" &&
          change.recorded.skill_version_id === change.skillVersionId &&
          change.recorded.expected_hash === change.hash &&
          change.recorded.path === change.path &&
          change.recorded.root === change.root &&
          change.recorded.destination === change.destination),
    );
  if (noop)
    for (const row of base.installed_skills)
      if ((yield* files.backups.scan(row.root, row.installed_skill_id)).length) {
        noop = false;
        break;
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
  // Persist only this review, not an ever-growing copy of earlier operations inside it.
  const reviewed = yield* Schema.encodeEffect(Plan)({
    ...input,
    next: {
      ...again.next,
      operations: [],
      installed_skills: again.next.installed_skills.filter((row) =>
        again.next.skills.some((skill) => skill.skill_id === row.skill_id),
      ),
    },
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)), Effect.mapError(invalid));
  const step: ApplyStep = {
    _tag: "Apply",
    reviewed,
    before: publication(base),
    routing,
    installedAt: DateTime.formatIso(yield* DateTime.now),
    ids: again.changes.flatMap((change) =>
      "skillVersionId" in change
        ? [{ path: change.path, id: change.recorded?.installed_skill_id ?? makeInstalledSkillId() }]
        : [],
    ),
    expected: [],
    prepared: false,
    completed: Option.none(),
  };
  return { step, snapshot, noop };
});

/** Root identities and expected rows become durable before the installer can change any skill. */
export const saveStep = Effect.fn("Library.saveApplyStep")(function* (
  operationId: OperationId,
  index: number,
  step: ApplyStep,
  batch?: string,
) {
  const writer = yield* LibraryWriter;
  const state = yield* loadLibrary(writer.home);
  const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
    state.operations,
  ).pipe(Effect.mapError(invalid));
  const operation = operations.find((item) => item.operationId === operationId);
  if (operation?._tag !== "Pending" || !operation.steps[index]) return yield* invalid();
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
  }).pipe(Effect.mapError(invalid));
  yield* writer.save(
    {
      ...state,
      operations: state.operations.map((item) =>
        item.operationId === operationId ? encoded : item,
      ),
    },
    state,
  );
});

/** Only original rows, or the exact pending/final rows this program can write, are accepted. */
const checkState = (step: ApplyStep, plan: Plan, state: LibraryState) => {
  const current = body(publication(state));
  if (!same(current, body(step.before)) && !same(current, body(publication(plan.next))))
    return false;
  for (const row of state.installed_skills) {
    const before = step.before.installed_skills.find(
      (item) => item.installed_skill_id === row.installed_skill_id,
    );
    const after = step.expected.find((item) => item.installed_skill_id === row.installed_skill_id);
    const touched = plan.changes.some(
      (change) =>
        "recorded" in change &&
        change.recorded?.installed_skill_id === row.installed_skill_id &&
        ["Manage", "Update", "Uninstall"].includes(change._tag),
    );
    if (
      ![
        before,
        after,
        touched && before && Status.pending(before),
        after && Status.pending(after),
      ].some((item) => item && same(row, item))
    )
      return false;
  }
  return step.before.installed_skills.every(
    (row) =>
      state.installed_skills.some((item) => item.installed_skill_id === row.installed_skill_id) ||
      plan.changes.some(
        (change) =>
          (change._tag === "Uninstall" || change._tag === "Forget") &&
          change.recorded.installed_skill_id === row.installed_skill_id,
      ),
  );
};

/** A missing predecessor is ours only when its lossless tree still exists in its own backup. */
const backedUp = Effect.fn("Library.checkApplyBackup")(function* (
  folder: InstalledSkills.Folder,
  row: InstalledSkill,
) {
  const files = yield* InstalledSkills.Service;
  for (const backup of yield* files.backups.scan(row.root, row.installed_skill_id))
    if ((yield* files.inspect(backup.path)).evidence === folder.evidence) return true;
  return false;
});

/** Validate every path before updating rows or executing any part of the replay. */
const checkFolders = Effect.fn("Library.checkApplyFolders")(function* (
  step: ApplyStep,
  plan: Plan,
  state: LibraryState,
) {
  const files = yield* InstalledSkills.Service;
  const completed: InstalledSkill[] = [];
  for (const saved of plan.folders) {
    const current = yield* files.inspect(saved.path);
    if (
      !same(saved.ancestors, current.ancestors) &&
      (step.prepared ||
        current.ancestors.some((ancestor) => {
          const prior = saved.ancestors.find((item) => item.path === ancestor.path);
          return (
            !prior ||
            (prior.evidence !== ancestor.evidence &&
              !(prior.evidence === "absent" && ancestor.evidence.startsWith("Directory:")))
          );
        }))
    )
      return yield* new InstalledSkills.Changed({ path: saved.path });
    const expected = step.expected.find((item) => item.path === saved.path);
    if (saved.evidence === current.evidence) {
      const recordedAfter =
        expected &&
        expected.status === "installed" &&
        state.installed_skills.some((row) => same(row, expected));
      const recordedBefore =
        expected && step.before.installed_skills.some((row) => same(row, expected));
      if (recordedAfter && !recordedBefore)
        return yield* new InstalledSkills.Changed({ path: saved.path });
      continue;
    }
    const facts = current.entry._tag === "Present" ? current.entry.facts : null;
    const marker = facts?.marker.kind === "valid" ? facts.marker.marker : undefined;
    if (
      expected &&
      expected.status === "installed" &&
      facts?.protection === null &&
      facts.hash === expected.expected_hash &&
      marker?.installed_skill_id === expected.installed_skill_id &&
      marker.skill_id === expected.skill_id &&
      marker.skill_version_id === expected.skill_version_id &&
      marker.expected_hash === expected.expected_hash
    ) {
      completed.push(expected);
      continue;
    }
    const change = plan.changes.find(
      (item) => "recorded" in item && item.recorded?.path === saved.path,
    );
    if (
      step.prepared &&
      current.entry._tag === "Absent" &&
      change &&
      "recorded" in change &&
      change.recorded &&
      ["Uninstall", "Update", "Manage"].includes(change._tag) &&
      (yield* backedUp(saved, change.recorded))
    )
      continue;
    return yield* new InstalledSkills.Changed({ path: saved.path });
  }
  return completed;
});

/** Prepare once, then accept only captured inputs or independently verified effects of this program. */
export const resumeApply = Effect.fn("Library.resumeRecordedApply")(function* (
  operationId: OperationId,
  index: number,
  saved: ApplyStep,
  batch?: string,
) {
  const writer = yield* LibraryWriter;
  const files = yield* InstalledSkills.Service;
  let step = saved;
  let plan = yield* reviewedApply(step);
  let state = yield* loadLibrary(writer.home);
  if (Option.isSome(step.completed)) {
    if (!same(publication(state), step.completed.value.state))
      return yield* new InstalledSkills.Changed({ path: libraryStatePath(writer.home) });
    for (const folder of step.completed.value.folders) {
      const current = yield* files.inspect(folder.path);
      if (folder.evidence !== current.evidence || !same(folder.ancestors, current.ancestors))
        return yield* new InstalledSkills.Changed({ path: folder.path });
    }
    return {
      expected: step.expected,
      state,
      base: snapshotOf({ present: true, state }),
      completed: true,
    };
  }
  if (!checkState(step, plan, state))
    return yield* new InstalledSkills.Changed({ path: libraryStatePath(writer.home) });
  let completed = yield* checkFolders(step, plan, state);
  if (!step.prepared) {
    yield* files.prepare([
      ...new Set(
        plan.changes.flatMap((change) =>
          "skillVersionId" in change && change._tag !== "KeepDeleted" && change._tag !== "Protected"
            ? [change.root]
            : [],
        ),
      ),
    ]);
    const folders = yield* Effect.forEach(plan.folders, (before) =>
      Effect.gen(function* () {
        const after = yield* files.inspect(before.path);
        if (
          before.evidence !== after.evidence ||
          after.ancestors.some((ancestor) => {
            const prior = before.ancestors.find((item) => item.path === ancestor.path);
            return (
              !prior ||
              (prior.evidence === "absent"
                ? ancestor.evidence !== "absent" && !ancestor.evidence.startsWith("Directory:")
                : prior.evidence !== ancestor.evidence)
            );
          })
        )
          return yield* new InstalledSkills.Changed({ path: before.path });
        return { ...before, ancestors: after.ancestors };
      }),
    );
    const expected: InstalledSkill[] = [];
    for (const change of plan.changes) {
      if (
        !("skillVersionId" in change) ||
        change._tag === "Protected" ||
        change._tag === "Unreadable"
      )
        continue;
      const id = step.ids.find((item) => item.path === change.path)?.id;
      if (!id) return yield* invalid();
      const hash =
        change._tag === "Install"
          ? (yield* files.build(change, plan.next, libraryOriginalsPath(writer.home))).hash
          : change._tag === "KeepDeleted"
            ? change.recorded.expected_hash
            : change.hash;
      const pending: InstalledSkill = {
        installed_skill_id: id,
        skill_id: change.skillId,
        skill_version_id: change.skillVersionId,
        destination: change.destination,
        root: change.root,
        path: change.path,
        expected_hash: hash,
        status: "pending",
        installed_at: step.installedAt,
      };
      expected.push(
        change._tag === "KeepDeleted"
          ? change.recorded.status === "suppressed"
            ? change.recorded
            : Status.suppressed(change.recorded, step.installedAt)
          : change._tag === "Conflict"
            ? Status.conflicted(pending, change.currentHash, change.expectedHash)
            : Status.installed(pending),
      );
    }
    plan = { ...plan, folders };
    const reviewed = yield* Schema.encodeEffect(Plan)(plan).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
      Effect.mapError(invalid),
    );
    step = { ...step, reviewed, expected, prepared: true };
    yield* saveStep(operationId, index, step, batch);
    state = yield* loadLibrary(writer.home);
    completed = yield* checkFolders(step, plan, state);
  }
  // A crash can leave our marker in place before the corresponding row was saved. Validate the
  // entire program first, then repair only those rows whose exact effect was verified above.
  if (completed.some((row) => !state.installed_skills.some((item) => same(item, row)))) {
    const paths = new Set(completed.map((row) => row.path));
    yield* writer.save(
      {
        ...state,
        installed_skills: [
          ...state.installed_skills.filter((row) => !paths.has(row.path)),
          ...completed,
        ],
      },
      state,
    );
    state = yield* loadLibrary(writer.home);
  }
  return {
    expected: step.expected,
    state,
    base: snapshotOf({ present: true, state }),
    completed: false,
  };
});
