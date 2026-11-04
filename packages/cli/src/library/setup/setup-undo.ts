import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { Effect, FileSystem, Option, Schema } from "effect";
import {
  canonicalJson,
  Hash,
  hashParts,
  Library,
  libraryStateRevision,
  LibraryStore,
  LinkStat,
  MachineSettings,
  setupIntent,
  SetupIntent,
  sourceImports,
  withLibraryWriter,
  writeJsonExclusive,
  type CollectionId,
  type LibraryState,
  type OperationId,
} from "@smolai/skit-core";
import { PlanIsStale } from "../failures.js";
import {
  ensureRecoveryOperation,
  recoveryOperationDirectory,
} from "../../library-application/recovery-moves.js";
import { RecoveryInvalid } from "../../library-application/recovery-evidence.js";
import { inspectSetupOperation } from "./setup-operation.js";
import {
  prepareSetupUndoFiles,
  installedSkillChoice,
  type SetupChanges,
  type SetupFile,
} from "./setup-undo-files.js";
import { prepareSetupSourceUndo, type UndoSourceImport } from "./setup-undo-sources.js";
import { reverseSetupIntent } from "./setup-undo-intent.js";

const { SetupDiscoverySettings, setupDiscoverySettings } = MachineSettings;

const AttemptFields = {
  planId: Hash,
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
const Done = Schema.Struct({ schemaVersion: Schema.Literal(1), planId: Hash });
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

/** A setup as undo reads it: what it changed, and its record, which the undo plan covers. */
interface SetupRecord extends SetupChanges {
  /** Where undo keeps its attempts: `removed/<operationId>/undo`. */
  readonly directory: string;
  readonly before: SetupIntent;
  readonly after: SetupIntent;
  readonly conflicts: readonly string[];
  /** Discovery settings: an old journal recorded them; MachineSettings keeps a state.json setup's. */
  readonly discovery:
    | {
        readonly _tag: "Journal";
        readonly legacy: MachineSettings.LegacySetupDiscovery;
      }
    | { readonly _tag: "MachineSettings"; readonly operationId: OperationId };
  readonly evidence: unknown;
}

/**
 * The nearest folder above `path` whose physical path is `parent`: the physical parent, or, when
 * setup created the folders between, the folder it recorded instead.
 */
const anchorOf = Effect.fn("SetupUndo.anchorOf")(function* (
  path: string,
  parent: { readonly path: string; readonly dev: bigint; readonly ino: bigint },
) {
  const links = yield* LinkStat;
  let candidate = dirname(path);
  for (;;) {
    const physical = yield* links.realPathNative(candidate).pipe(Effect.option);
    if (Option.isSome(physical) && physical.value === parent.path) break;
    if (dirname(candidate) === candidate) {
      candidate = dirname(path);
      break;
    }
    candidate = dirname(candidate);
  }
  return { path: candidate, physicalPath: parent.path, dev: parent.dev, ino: parent.ino };
});

/** What a step recorded at one path, as undo reads it. */
const setupFile = Effect.fn("SetupUndo.setupFile")(function* (
  evidence: Library.FolderEvidence | Library.LinkEvidence | Library.AbsentEvidence,
) {
  const anchor = yield* anchorOf(evidence.path, evidence.parent);
  const entry: SetupFile["entry"] =
    evidence._tag === "Absent"
      ? null
      : evidence._tag === "SymbolicLink"
        ? {
            dev: evidence.dev,
            ino: evidence.ino,
            type: "SymbolicLink",
            hash: evidence.contentHash,
            unmarked: { by: "fingerprint", hash: evidence.contentHash },
            marker: null,
            linkTarget: evidence.linkTarget,
          }
        : {
            dev: evidence.dev,
            ino: evidence.ino,
            type: "Directory",
            hash: evidence.contentHash,
            unmarked: { by: "tree", hash: evidence.treeHash },
            marker: Option.getOrNull(evidence.marker),
            // SKIT writes its marker owner-only (install/files.ts).
            markerType: Option.isSome(evidence.marker) ? "File" : null,
            markerMode: Option.isSome(evidence.marker) ? 0o100600 : null,
            linkTarget: null,
          };
  return { path: evidence.path, anchor, entry } satisfies SetupFile;
});

/** A setup recorded in state.json: its steps' evidence and what it held before and after. */
const recordedSetup = Effect.fn("SetupUndo.recordedSetup")(function* (
  home: string,
  operation: Library.OperationStatus,
) {
  const after = operation._tag === "Pending" ? operation.before : operation.after;
  const evidence = operation.steps.flatMap(({ before }) =>
    before.flatMap((item) => (item._tag === "Retained" ? [] : [item])),
  );
  const files: SetupFile[] = [];
  for (const item of evidence)
    if (!files.some((file) => file.path === item.path)) files.push(yield* setupFile(item));
  return {
    directory: join(home, "removed", operation.operationId),
    before: operation.before.intent,
    after: after.intent,
    installedSkillsBefore: operation.before.installedSkills,
    installedSkillsAfter: after.installedSkills,
    files,
    approvedPaths: new Set(files.map((file) => file.path)),
    // The Done or Stopped write recorded every copy the setup's steps installed.
    claimedPaths: new Set(
      after.installedSkills
        .filter(
          (copy) =>
            copy.status === "installed" &&
            !equal(
              copy,
              operation.before.installedSkills.find(
                (item) => item.installed_skill_id === copy.installed_skill_id,
              ),
            ),
        )
        .map((copy) => copy.path),
    ),
    conflicts:
      operation._tag === "Pending"
        ? ["Setup has not finished. Run any SKIT command to finish or stop it, then undo it."]
        : [],
    discovery: { _tag: "MachineSettings", operationId: operation.operationId },
    evidence: yield* Schema.encodeEffect(Library.OperationStatus)(operation),
  } satisfies SetupRecord;
});

/** A setup from before state.json recorded operations, read from its journal. */
const journalSetup = Effect.fn("SetupUndo.journalSetup")(function* (
  home: string,
  operationId: string,
  state: LibraryState,
) {
  const saved = yield* inspectSetupOperation(home, operationId);
  const conflicts: string[] = [];
  let expected = saved.operation.before;
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
    }
  }
  return {
    directory: saved.directory,
    before: saved.operation.before,
    after: expected,
    installedSkillsBefore: saved.operation.installedSkills,
    installedSkillsAfter: installedSkills,
    files: saved.operation.files.map((file): SetupFile => ({
      path: file.path,
      anchor: file.anchor,
      entry:
        file.entry === null
          ? null
          : {
              ...file.entry,
              unmarked: { by: "fingerprint", hash: file.entry.unstampedHash },
            },
    })),
    approvedPaths:
      saved.operation.installedSkillPaths === undefined
        ? undefined
        : new Set(saved.operation.installedSkillPaths),
    claimedPaths: confirmedInstalledSkillPaths,
    conflicts,
    discovery: {
      _tag: "Journal",
      legacy: {
        before: saved.operation.settings,
        machineId: saved.operation.machineId,
        changes: saved.changes.flatMap(({ change, saved: confirmed }) =>
          change.kind === "settings"
            ? [
                {
                  before: change.before,
                  after: change.after,
                  machineId: change.machineId,
                  confirmed,
                },
              ]
            : [],
        ),
      },
    },
    evidence: saved,
  } satisfies SetupRecord;
});

const readUndo = Effect.fn("SetupUndo.read")(function* (
  operationId: string,
  backupDirectory: string,
  undoSourceImports: Map<CollectionId, UndoSourceImport>,
) {
  const store = yield* LibraryStore;
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const state = yield* store.load;
  const operations = yield* Schema.decodeUnknownEffect(Schema.Array(Library.OperationStatus))(
    state.operations,
  ).pipe(Effect.mapError(() => new RecoveryInvalid({ detail: "Invalid setup record" })));
  const recorded = operations.find((operation) => operation.operationId === operationId);
  if (!/^[a-zA-Z0-9_-]+$/.test(operationId))
    return yield* new RecoveryInvalid({ detail: "Invalid operation identifier" });
  // Only the latest finished setup keeps its record; older ones may have their journal.
  if (
    recorded === undefined &&
    !(yield* fs.exists(join(store.home, "removed", operationId, "setup.json")))
  )
    return yield* new RecoveryInvalid({
      detail: `Setup ${operationId} has no undo record: a later setup replaced it`,
    });
  const setup =
    recorded === undefined
      ? yield* journalSetup(store.home, operationId, state)
      : yield* recordedSetup(store.home, recorded);
  const undoDirectory = join(setup.directory, "undo");
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
  const discovery = yield* MachineSettings.planRestoreDiscovery(
    store.home,
    operationId,
    setup.discovery._tag === "Journal" ? setup.discovery.legacy : undefined,
  );
  const settings = discovery.before;
  const conflicts: string[] = [...setup.conflicts];
  const sources = done
    ? { conflicts: [], evidence: [], restorations: [] }
    : yield* prepareSetupSourceUndo(
        state,
        setup.before,
        setup.after,
        store.originalsPath,
        settings.machineId,
        undoSourceImports,
      );
  const intent = reverseSetupIntent(state, setup.before, setup.after, sources.restorations);
  conflicts.push(...sources.conflicts, ...intent.conflicts, ...discovery.conflicts);
  const files = done
    ? undefined
    : yield* prepareSetupUndoFiles(
        operationId,
        setup,
        state,
        backupDirectory,
        priorBackups,
        intent.state,
      );
  if (files) conflicts.push(...files.conflicts);
  const nextInstalledSkills = structuredClone(intent.state.installed_skills);
  for (const path of files?.affected ?? []) {
    const prior = setup.installedSkillsBefore.find((item) => item.path === path);
    const current = nextInstalledSkills.find((item) => item.path === path);
    if (equal(installedSkillChoice(prior), installedSkillChoice(current))) continue;
    const index = nextInstalledSkills.findIndex((item) => item.path === path);
    if (index >= 0) nextInstalledSkills.splice(index, 1);
    if (prior) nextInstalledSkills.push(structuredClone(prior));
  }
  const next = { ...intent.state, installed_skills: nextInstalledSkills };
  const planId = hashParts([
    canonicalJson({
      saved: setup.evidence,
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
    setup,
    state,
    settings,
    next,
    restoredSettings: discovery.after,
    discoveryPlan: discovery,
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
          yield* ensureRecoveryOperation(store.home, current.setup.directory);
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
          if (current.discoveryPlan.recorded)
            yield* MachineSettings.applyRestoreDiscovery(store.home, current.discoveryPlan);
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
