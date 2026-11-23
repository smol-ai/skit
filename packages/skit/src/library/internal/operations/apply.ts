import { LibraryRecoveryNotice } from "../../recovery-notice.js";
import { samePathChain } from "../../../platform/path-evidence.js";
import { Data, Effect, type Result } from "effect";
import type { ApplyError } from "../../library-plan.js";
import * as InstalledSkills from "../../installed-skills.js";
import * as Status from "../../installed-skill-status.js";
import {
  LibraryWriter,
  libraryOriginalsPath,
  libraryVariantsPath,
  libraryStatePath,
  loadLibrary,
} from "../../store/library-store.js";
import { libraryStateRevision, type LibraryState } from "../../library-state.js";
import { type InstalledSkill } from "../../device-state.js";
import type { OperationId } from "../../entity-ids.js";
import type { RecordedInstalledChange, SyncFolder } from "../../store/state-schema.js";
import { execute } from "./installed-changes.js";
import { saveStep } from "./recorded.js";
import {
  hashBody,
  prepareApplyState,
  copiesOf,
  finalRows,
  rowAfter,
  same,
  type ApplyStep,
} from "./program.js";
import { applyOutcome } from "./result.js";

/** Private execution context, unwrapped before any public outcome or durable error is made. */
class InstalledChangeFailed extends Data.TaggedError("Library.InstalledChangeFailed")<{
  readonly path: string;
  readonly cause: ApplyError | InstalledSkills.Changed;
}> {}

const pathOf = (step: ApplyStep, change: RecordedInstalledChange) =>
  change._tag === "Install" || change._tag === "Save"
    ? change.row.path
    : change._tag === "Fail"
      ? change.path
      : step.previousInstalledSkills.find((row) => row.installed_skill_id === change.id)?.path;
const observation = (folder: InstalledSkills.Folder): SyncFolder => ({
  ...folder,
  entry: folder.entry._tag === "Absent" ? "Absent" : folder.entry.kind,
});
const matchesRow = (folder: InstalledSkills.Folder, row: InstalledSkill) => {
  const facts = folder.entry._tag === "Present" ? folder.entry.facts : null;
  const marker = facts?.marker.kind === "valid" ? facts.marker.marker : undefined;
  return (
    folder.entry._tag === "Present" &&
    folder.entry.kind === "Directory" &&
    row.status === "installed" &&
    facts?.protection === null &&
    facts.hash === row.expected_hash &&
    marker?.installed_skill_id === row.installed_skill_id &&
    marker.skill_id === row.skill_id &&
    marker.skill_version_id === row.skill_version_id &&
    marker.expected_hash === row.expected_hash
  );
};
const withRow = (
  state: LibraryState,
  change: RecordedInstalledChange,
  row: InstalledSkill | undefined,
): LibraryState => {
  if (change._tag === "Fail") return state;
  const id =
    change._tag === "Install" || change._tag === "Save" ? change.row.installed_skill_id : change.id;
  const present = state.installed_skills.some((item) => item.installed_skill_id === id);
  return {
    ...state,
    installed_skills: [
      ...state.installed_skills.flatMap((item) =>
        item.installed_skill_id === id ? (row ? [row] : []) : [item],
      ),
      ...(!present && row ? [row] : []),
    ],
  };
};
const ancestorsMatch = (
  before: SyncFolder,
  current: InstalledSkills.Folder,
  allowCreation: boolean,
) => samePathChain(before.ancestors, current.ancestors, allowCreation);
const backedUp = Effect.fn("Library.checkApplyPredecessor")(function* (
  before: SyncFolder,
  row: InstalledSkill,
) {
  const files = yield* InstalledSkills.Service;
  for (const backup of yield* files.backups.scan(row.root, row.installed_skill_id))
    if ((yield* files.inspect(backup.path)).evidence === before.evidence) return true;
  return false;
});

/** Every state and folder is checked before any recovery save or filesystem mutation. */
export const checkApply = Effect.fn("Library.checkRecordedApply")(function* (step: ApplyStep) {
  const { home } = yield* LibraryWriter;
  const state = yield* loadLibrary(home);
  const files = yield* InstalledSkills.Service;
  const changed = (path: string) => new InstalledSkills.Changed({ path });
  const bodyHash = yield* hashBody(state);
  if (step.phase._tag === "Done") {
    if (bodyHash !== step.afterHash || !same(state.installed_skills, finalRows(step)))
      return yield* changed(libraryStatePath(home));
    for (const saved of step.phase.folders) {
      const current = yield* files.inspect(saved.path);
      if (saved.evidence !== current.evidence || !same(saved.ancestors, current.ancestors))
        return yield* changed(saved.path);
    }
    return state;
  }
  if (bodyHash !== step.beforeHash && bodyHash !== step.afterHash)
    return yield* changed(libraryStatePath(home));
  const after = finalRows(step);
  for (const row of state.installed_skills) {
    const prior = step.previousInstalledSkills.find(
      (item) => item.installed_skill_id === row.installed_skill_id,
    );
    const next = after.find((item) => item.installed_skill_id === row.installed_skill_id);
    if (
      ![prior, next, prior && Status.pending(prior), next && Status.pending(next)].some(
        (item) => item && same(item, row),
      )
    )
      return yield* changed(row.path);
  }
  for (const prior of step.previousInstalledSkills)
    if (
      !state.installed_skills.some((row) => row.installed_skill_id === prior.installed_skill_id) &&
      !step.changes.some(
        (change) =>
          (change._tag === "Uninstall" || change._tag === "Forget") &&
          change.id === prior.installed_skill_id,
      )
    )
      return yield* changed(prior.path);
  for (const saved of step.folders) {
    const current = yield* files.inspect(saved.path);
    const change = step.changes.find((change) => pathOf(step, change) === saved.path);
    if (!ancestorsMatch(saved, current, change?._tag === "Install"))
      return yield* changed(saved.path);
    if (saved.evidence === current.evidence) {
      if (
        change?._tag === "Install" &&
        state.installed_skills.some((row) => same(row, change.row)) &&
        !step.previousInstalledSkills.some((row) => same(row, change.row))
      )
        return yield* changed(saved.path);
      continue;
    }
    if (change?._tag === "Install" && matchesRow(current, change.row)) continue;
    if (
      current.entry._tag === "Absent" &&
      (change?._tag === "Install" || change?._tag === "Uninstall")
    ) {
      const prior = step.previousInstalledSkills.find((row) => row.path === saved.path);
      if (prior && (yield* backedUp(saved, prior))) continue;
    }
    return yield* changed(saved.path);
  }
  return state;
});

/** Execute fixed decisions. Recovery never calls the planner or invents an installed row. */
export const apply = Effect.fn("Library.applyRecordedChanges")(function* (
  saved: ApplyStep,
  operationId: OperationId,
  index: number,
  batch?: string,
) {
  const writer = yield* LibraryWriter;
  const files = yield* InstalledSkills.Service;
  let revision = yield* writer.revision;
  let step = saved;
  let current = yield* checkApply(step);
  if (step.phase._tag === "Pending") {
    const target = yield* prepareApplyState(step, current, "after", writer.home);
    const roots = step.changes.flatMap((change) =>
      change._tag === "Install" ? [change.row.root] : [],
    );
    yield* files.prepare(roots);
    const folders = yield* Effect.forEach(step.folders, (before) =>
      Effect.gen(function* () {
        const now = yield* files.inspect(before.path);
        if (
          !ancestorsMatch(
            before,
            now,
            step.changes.some(
              (change) => change._tag === "Install" && change.row.path === before.path,
            ),
          )
        )
          return yield* new InstalledSkills.Changed({ path: before.path });
        return { ...before, ancestors: now.ancestors };
      }),
    );
    if (!same(folders, step.folders)) {
      step = { ...step, folders };
      yield* saveStep(operationId, index, step, batch);
      current = yield* loadLibrary(writer.home);
    }
    if (step.save === "before") {
      const next = {
        ...target,
        installed_skills: current.installed_skills,
      };
      if (libraryStateRevision(next) !== libraryStateRevision(current)) {
        if (
          step.bodyChange?._tag === "Enabled" &&
          step.bodyChange.fields.every(({ field }) =>
            [
              "enabled",
              "invocation_policies",
              "repositories",
              "device_skill_selection",
              "pending_device_selection_origin",
            ].includes(field),
          )
        )
          revision = yield* writer.saveEnabled(next, current, revision);
        else {
          yield* writer.save(next, current, revision);
          revision = yield* writer.revision;
        }
        current = next;
      }
    }
    const saveRow = (change: RecordedInstalledChange, row: InstalledSkill | undefined) =>
      Effect.gen(function* () {
        if (change._tag === "Fail") return;
        const id =
          change._tag === "Install" || change._tag === "Save"
            ? change.row.installed_skill_id
            : change.id;
        const before = current.installed_skills.find((item) => item.installed_skill_id === id);
        if (same(before, row)) return;
        revision = yield* writer.saveInstalledSkill(row, before, revision);
        current = withRow(current, change, row);
      });
    for (const change of step.changes) {
      const path = pathOf(step, change);
      const folder =
        path === undefined
          ? undefined
          : yield* files
              .inspect(path)
              .pipe(Effect.mapError((cause) => new InstalledChangeFailed({ path, cause })));
      const alreadyWritten = change._tag === "Install" && folder && matchesRow(folder, change.row);
      const alreadyAbsent = change._tag === "Uninstall" && folder?.entry._tag === "Absent";
      const before =
        path === undefined ? undefined : step.folders.find((item) => item.path === path);
      if (folder && before) {
        if (!ancestorsMatch(before, folder, false))
          return yield* new InstalledChangeFailed({
            path: folder.path,
            cause: new InstalledSkills.Changed({ path: folder.path }),
          });
        if (!alreadyWritten && before.evidence !== folder.evidence) {
          const prior = step.previousInstalledSkills.find((row) => row.path === folder.path);
          const displaced =
            folder.entry._tag === "Absent" &&
            prior &&
            (change._tag === "Install" || change._tag === "Uninstall") &&
            (yield* backedUp(before, prior));
          if (!displaced)
            return yield* new InstalledChangeFailed({
              path: folder.path,
              cause: new InstalledSkills.Changed({ path: folder.path }),
            });
        }
      }
      if (!alreadyWritten && !alreadyAbsent) {
        if (change._tag === "Install" && change.verification === "manage") {
          yield* saveRow(change, Status.pending(change.row));
        }
        yield* execute(
          change,
          { ...target, installed_skills: current.installed_skills },
          folder,
          libraryOriginalsPath(writer.home),
          libraryVariantsPath(writer.home),
        ).pipe(
          Effect.tapError(() =>
            Effect.gen(function* () {
              const prior = step.previousInstalledSkills.find((row) => row.path === path);
              if (
                !prior ||
                path === undefined ||
                (yield* files.inspect(path)).entry._tag !== "Absent"
              )
                return;
              yield* saveRow(change, prior.status === "suppressed" ? prior : Status.pending(prior));
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  LibraryRecoveryNotice.cases.PendingStateSaveFailed.make({
                    home: writer.home,
                    ...(path === undefined ? {} : { path }),
                    failure: error,
                  }),
                ),
              ),
            ),
          ),
          Effect.mapError((cause) =>
            path === undefined ? cause : new InstalledChangeFailed({ path, cause }),
          ),
        );
      }
      const prior =
        change._tag === "Uninstall"
          ? step.previousInstalledSkills.find((row) => row.installed_skill_id === change.id)
          : undefined;
      // Until the whole batch commits, a moved predecessor remains recorded as pending.
      const after = prior
        ? prior.status === "suppressed"
          ? prior
          : Status.pending(prior)
        : rowAfter(step, change);
      yield* saveRow(change, after);
    }
    yield* checkApply(step);
    const foldersAfter = yield* Effect.forEach(step.folders, (folder) =>
      Effect.map(files.inspect(folder.path), observation),
    );
    step = { ...step, phase: { _tag: "Done", folders: foldersAfter } };
    yield* saveStep(operationId, index, step, batch, target, current, revision);
  }
  const touched = step.changes.flatMap((change) =>
    change._tag === "Install" || change._tag === "Save"
      ? [change.row]
      : change._tag === "Fail"
        ? []
        : step.previousInstalledSkills.filter((row) => row.installed_skill_id === change.id),
  );
  const prior = yield* Effect.result(prepareApplyState(step, current, "before", writer.home));
  yield* settleBackups(prior, touched);
  return yield* applyOutcome(step, yield* loadLibrary(writer.home), {
    _tag: "Applied",
    results: [],
    copies: copiesOf(step),
  });
}, Effect.scoped);
/** Called only after committing state, including when startup verifies a completed apply. */
const settleBackups = Effect.fn("Library.settleApplyBackups")(function* (
  prior: Result.Result<LibraryState, Effect.Error<ReturnType<typeof prepareApplyState>>>,
  rows: readonly InstalledSkill[],
) {
  const { home } = yield* LibraryWriter;
  const files = yield* InstalledSkills.Service;
  const unique = rows.filter(
    (row, index) =>
      rows.findIndex(
        (other) => other.installed_skill_id === row.installed_skill_id && other.root === row.root,
      ) === index,
  );
  for (const copy of unique)
    yield* Effect.gen(function* () {
      for (const backup of yield* files.backups.scan(copy.root, copy.installed_skill_id)) {
        const reproducible =
          prior._tag === "Success" &&
          (yield* files.backups
            .check(backup, prior.success, libraryOriginalsPath(home), copy.installed_skill_id)
            .pipe(Effect.orElseSucceed(() => false)));
        yield* reproducible ? files.backups.discard(backup) : files.backups.keep(backup);
        if (prior._tag === "Failure")
          yield* Effect.logWarning(
            LibraryRecoveryNotice.cases.BackupsStillPending.make({
              home,
              installedSkillId: copy.installed_skill_id,
              path: copy.path,
              failure: prior.failure,
            }),
          );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          LibraryRecoveryNotice.cases.BackupsStillPending.make({
            home,
            installedSkillId: copy.installed_skill_id,
            path: copy.path,
            failure: error,
          }),
        ),
      ),
    );
});
