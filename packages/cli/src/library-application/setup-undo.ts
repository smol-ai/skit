import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import {
  canonicalJson,
  Digest,
  hashParts,
  libraryStateRevision,
  LibraryStore,
  LinkStat,
  MachineSettings,
  sourceImports,
  withLibraryWriter,
  writeJsonExclusive,
  type CollectionId,
} from "@smolai/skit-core";
import { PlanIsStale } from "../library/failures.js";
import { ensureRecoveryOperation, recoveryOperationDirectory } from "./recovery-moves.js";
import { RecoveryInvalid } from "./recovery-evidence.js";
import { inspectSetupOperation } from "./setup-operation.js";
import { prepareSetupUndoFiles, installedSkillChoice } from "./setup-undo-files.js";
import { prepareSetupSourceUndo, type UndoSourceImport } from "./setup-undo-sources.js";
import {
  reverseSetupDiscovery,
  reverseSetupIntent,
  setupDiscoverySettings,
  setupIntent,
  SetupIntent,
  SetupDiscoverySettings,
} from "./setup-undo-intent.js";

const AttemptFields = {
  planId: Digest,
  settingsBefore: SetupDiscoverySettings,
  settingsAfter: SetupDiscoverySettings,
};
const Attempt = Schema.Struct({
  ...AttemptFields,
  schemaVersion: Schema.Literal(2),
  /** The recovery folder this attempt moved copies into. */
  backupId: Schema.String,
  before: SetupIntent,
  after: SetupIntent,
});
const StoredAttempt = Attempt;
const Done = Schema.Struct({ schemaVersion: Schema.Literal(1), planId: Digest });
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

const readUndo = Effect.fn("SetupUndo.read")(function* (
  operationId: string,
  backupDirectory: string,
  undoSourceImports: Map<CollectionId, UndoSourceImport>,
) {
  const store = yield* LibraryStore;
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const saved = yield* inspectSetupOperation(store.home, operationId);
  const state = yield* store.load;
  const settings = yield* MachineSettings.read(store.home);
  const undoDirectory = join(saved.directory, "undo");
  const undoInfo = yield* links.identity
    .lstat(undoDirectory)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  const priorBackups: string[] = [];
  const attempts: unknown[] = [];
  let done = false;
  if (undoInfo) {
    if (undoInfo.type !== "Directory")
      return yield* new RecoveryInvalid({ detail: "Redirected setup undo directory" });
    const names = (yield* fs.readDirectory(undoDirectory)).sort();
    for (const name of names) {
      if (!/^[0-9a-f-]+(?:\.done)?\.json$/.test(name))
        return yield* new RecoveryInvalid({ detail: "Unexpected setup undo evidence" });
      const path = join(undoDirectory, name);
      if ((yield* links.identity.lstat(path)).type !== "File")
        return yield* new RecoveryInvalid({ detail: "Redirected setup undo record" });
      const raw = yield* fs.readFileString(path);
      attempts.push(raw);
      if (name.endsWith(".done.json")) {
        const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Done))(raw).pipe(
          Effect.mapError(() => new RecoveryInvalid({ detail: "Invalid undo completion" })),
        );
        const attemptPath = join(undoDirectory, name.replace(".done.json", ".json"));
        if ((yield* links.identity.lstat(attemptPath)).type !== "File")
          return yield* new RecoveryInvalid({ detail: "Missing undo record" });
        const attempt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredAttempt))(
          yield* fs.readFileString(attemptPath),
        ).pipe(Effect.mapError(() => new RecoveryInvalid({ detail: "Invalid undo record" })));
        if (attempt.planId !== value.planId)
          return yield* new RecoveryInvalid({ detail: "Undo completion differs from its record" });
        done = true;
      } else {
        const attempt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredAttempt))(
          raw,
        ).pipe(Effect.mapError(() => new RecoveryInvalid({ detail: "Invalid undo record" })));
        priorBackups.push(attempt.backupId);
      }
    }
  }
  const conflicts: string[] = [];
  const expectedMachine = saved.changes.reduce(
    (id, entry) => (entry.change.kind === "settings" ? entry.change.machineId : id),
    saved.operation.machineId,
  );
  if (expectedMachine !== null && settings.machineId !== expectedMachine)
    conflicts.push("Setup belongs to a different machine identity");
  let expected = saved.operation.before;
  let expectedSettings = saved.operation.settings;
  let installedSkills = saved.operation.installedSkills;
  const confirmedInstalledSkillPaths = new Set(
    saved.complete ? (saved.operation.installedSkillPaths ?? []) : [],
  );
  for (const { change, saved: confirmed } of saved.changes) {
    if (change.kind === "library") {
      const applied = confirmed || libraryStateRevision(state) === change.afterRevision;
      if (!applied && libraryStateRevision(state) !== change.beforeRevision)
        conflicts.push("Unconfirmed setup Library save differs from both recorded revisions");
      if (applied) {
        expected = change.after;
        installedSkills = change.installedSkillsAfter;
        for (const installedSkill of change.installedSkillsAfter)
          if (
            installedSkill.status === "installed" &&
            !equal(
              installedSkill,
              change.installedSkillsBefore.find(
                (item) => item.installed_skill_id === installedSkill.installed_skill_id,
              ),
            )
          )
            confirmedInstalledSkillPaths.add(installedSkill.path);
      }
    } else {
      const current = setupDiscoverySettings(settings);
      const applied = confirmed || equal(current, change.after);
      if (!applied && !equal(current, change.before))
        conflicts.push("Unconfirmed setup settings save differs from both recorded values");
      if (applied) expectedSettings = change.after;
    }
  }
  const sources = done
    ? { conflicts: [], evidence: [], restorations: [] }
    : yield* prepareSetupSourceUndo(
        state,
        saved.operation.before,
        expected,
        store.originalsPath,
        settings.machineId,
        undoSourceImports,
      );
  const intent = reverseSetupIntent(state, saved.operation.before, expected, sources.restorations);
  const discovery = reverseSetupDiscovery(settings, saved.operation.settings, expectedSettings);
  conflicts.push(...sources.conflicts, ...intent.conflicts, ...discovery.conflicts);
  const files = done
    ? undefined
    : yield* prepareSetupUndoFiles(
        operationId,
        saved.operation,
        installedSkills,
        state,
        backupDirectory,
        priorBackups,
        intent.state,
        confirmedInstalledSkillPaths,
      );
  if (files) conflicts.push(...files.conflicts);
  const nextInstalledSkills = structuredClone(intent.state.installed_skills);
  for (const path of files?.affected ?? []) {
    const prior = saved.operation.installedSkills.find((item) => item.path === path);
    const current = nextInstalledSkills.find((item) => item.path === path);
    if (equal(installedSkillChoice(prior), installedSkillChoice(current))) continue;
    const index = nextInstalledSkills.findIndex((item) => item.path === path);
    if (index >= 0) nextInstalledSkills.splice(index, 1);
    if (prior) nextInstalledSkills.push(structuredClone(prior));
  }
  const next = { ...intent.state, installed_skills: nextInstalledSkills };
  const planId = hashParts([
    canonicalJson({
      saved,
      revision: libraryStateRevision(state),
      settings,
      attempts,
      sources: sources.evidence,
      files: files && {
        pathDetails: files.pathDetails,
        sources: files.sourceEvidence,
        actions: files.actions,
      },
      conflicts,
    }),
  ]);
  return {
    summary: {
      operationId,
      planId,
      status: done
        ? ("already-undone" as const)
        : conflicts.length
          ? ("conflicted" as const)
          : ("ready" as const),
      conflicts: done ? [] : conflicts,
      files: done ? [] : files!.actions.map(({ path, kind }) => ({ path, kind })),
      sourceSelections: sources.restorations.map((restored) => ({
        collectionId: restored.collection_id,
        label: state.collections.find((item) => item.collection_id === restored.collection_id)!
          .label,
        fromSnapshot: state.collection_versions.find(
          (item) =>
            item.collection_version_id ===
            sourceImports(state, restored.collection_id)[0].collection_version_id,
        )!.hash,
        toSnapshot: state.collection_versions.find(
          (item) => item.collection_version_id === restored.collection_version_id,
        )!.hash,
      })),
      intentChanged: !done && !equal(setupIntent(state), setupIntent(next)),
      settingsChanged: !done && discovery.changed,
    },
    saved,
    state,
    settings,
    next,
    restoredSettings: discovery.settings,
    files,
    undoDirectory,
  };
});

/** A passive review followed by exact reobservation under the existing Library writer. */
export const prepareSetupUndo = Effect.fn("SetupUndo.prepare")(function* (operationId: string) {
  const store = yield* LibraryStore;
  const fs = yield* FileSystem.FileSystem;
  const backupDirectory = recoveryOperationDirectory(store.home);
  const undoSourceImports = new Map<CollectionId, UndoSourceImport>();
  const reviewed = yield* readUndo(operationId, backupDirectory, undoSourceImports);
  return {
    summary: reviewed.summary,
    apply: () =>
      withLibraryWriter(
        Effect.gen(function* () {
          const current = yield* readUndo(operationId, backupDirectory, undoSourceImports);
          if (current.summary.planId !== reviewed.summary.planId) return yield* new PlanIsStale();
          if (current.summary.status === "already-undone") return current.summary;
          if (current.summary.conflicts.length)
            return yield* new RecoveryInvalid({ detail: current.summary.conflicts.join("; ") });
          yield* ensureRecoveryOperation(store.home, backupDirectory);
          yield* fs
            .makeDirectory(current.undoDirectory, { mode: 0o700 })
            .pipe(
              Effect.catchTag("PlatformError", (error) =>
                error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
              ),
            );
          const links = yield* LinkStat;
          if ((yield* links.identity.lstat(current.undoDirectory)).type !== "Directory")
            return yield* new RecoveryInvalid({ detail: "Redirected undo directory" });
          const id = randomUUID();
          yield* writeJsonExclusive(join(current.undoDirectory, `${id}.json`), {
            schemaVersion: 2,
            planId: current.summary.planId,
            backupId: basename(backupDirectory),
            before: setupIntent(current.state),
            after: setupIntent(current.next),
            settingsBefore: setupDiscoverySettings(current.settings),
            settingsAfter: setupDiscoverySettings(current.restoredSettings),
          } satisfies typeof Attempt.Type);
          yield* current.files!.apply();
          if (!equal(current.state, current.next)) yield* store.save(current.next, current.state);
          if (current.summary.settingsChanged)
            yield* MachineSettings.restoreDiscovery(
              store.home,
              current.settings,
              current.restoredSettings,
            );
          if (
            libraryStateRevision(yield* store.load) !== libraryStateRevision(current.next) ||
            !equal(
              setupDiscoverySettings(yield* MachineSettings.read(store.home)),
              setupDiscoverySettings(current.restoredSettings),
            )
          )
            return yield* new RecoveryInvalid({
              detail: "Undo publications did not reach the reviewed final state",
            });
          yield* writeJsonExclusive(join(current.undoDirectory, `${id}.done.json`), {
            schemaVersion: 1,
            planId: current.summary.planId,
          } satisfies typeof Done.Type);
          return {
            ...current.summary,
            status: "undone" as const,
            backupId: basename(backupDirectory),
          };
        }),
      ),
  };
});
