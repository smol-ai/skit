import { basename, dirname, join, resolve } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import {
  AbsoluteDevicePath,
  enabledSkillIds,
  canonicalJson,
  deviceInstallationIntent,
  Digest,
  hashParts,
  LibraryState,
  LibraryChanged,
  libraryStateRevision,
  LibraryStore,
  LinkStat,
  MachineId,
  MachineSettings,
  InstalledSkill,
  InstallDestination,
  writeJsonExclusive,
  type MachineSettingsSnapshot,
} from "@smolai/skit-core";
import { activeInstallDestinations, skillsDirectoryFor } from "../install/roots.js";
import type { SetupApproval } from "../workflows/library/setup-apply.js";
import { ensureRecoveryOperation, recoveryOperationPath } from "./recovery-moves.js";
import { RecoveryInvalid, recoveryFingerprint } from "./recovery-evidence.js";
import {
  SetupDiscoverySettings,
  setupDiscoverySettings,
  SetupIntent,
  setupIntent,
} from "./setup-undo-intent.js";

const Identity = Schema.Struct({ dev: Schema.Number, ino: Schema.Number });
const DevicePath = AbsoluteDevicePath.check(
  Schema.makeFilter((path) => resolve(path) === path, {
    message: "Expected a normalized absolute device path",
  }),
);
const FileEvidence = Schema.Struct({
  path: DevicePath,
  anchor: Schema.Struct({ path: DevicePath, physicalPath: DevicePath, ...Identity.fields }),
  entry: Schema.NullOr(
    Schema.Struct({
      ...Identity.fields,
      type: Schema.String,
      hash: Digest,
      unstampedHash: Digest,
      marker: Schema.NullOr(Schema.String),
      markerType: Schema.optionalKey(Schema.NullOr(Schema.String)),
      markerMode: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      linkTarget: Schema.NullOr(Schema.String),
    }),
  ),
});
const OperationFields = {
  kind: Schema.Literal("setup"),
  planId: Digest,
  settings: SetupDiscoverySettings,
  machineId: Schema.NullOr(MachineId),
  targets: Schema.Array(Schema.Struct({ target: InstallDestination, root: DevicePath })),
  files: Schema.Array(FileEvidence),
};
const Operation = Schema.Struct({
  ...OperationFields,
  schemaVersion: Schema.Literal(2),
  before: SetupIntent,
  installedSkills: Schema.Array(InstalledSkill),
  installedSkillPaths: Schema.optionalKey(Schema.Array(DevicePath)),
});
const LibraryChangeFields = {
  sequence: Schema.Int,
  kind: Schema.Literal("library"),
  beforeRevision: Schema.String,
  afterRevision: Schema.String,
};
const LibraryChange = Schema.Struct({
  ...LibraryChangeFields,
  schemaVersion: Schema.Literal(2),
  before: SetupIntent,
  after: SetupIntent,
  installedSkillsBefore: Schema.Array(InstalledSkill),
  installedSkillsAfter: Schema.Array(InstalledSkill),
});
const SettingsChange = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sequence: Schema.Int,
  kind: Schema.Literal("settings"),
  before: SetupDiscoverySettings,
  after: SetupDiscoverySettings,
  machineId: Schema.NullOr(MachineId),
});
const SaveConfirmation = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sequence: Schema.Int,
  digest: Digest,
});
const Completion = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  intent: SetupIntent,
  settings: SetupDiscoverySettings,
  installedSkills: Schema.Array(InstalledSkill),
});

const StoredOperation = Operation;
const StoredChange = Schema.Union([LibraryChange, SettingsChange]);
const StoredCompletion = Completion;

const maybeStat = Effect.fn("SetupOperation.stat")(function* (path: string) {
  const links = yield* LinkStat;
  return yield* links.identity
    .lstat(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
});

/** Bind absent entries to an existing physical ancestor as well as recording present bytes. */
export const readSkillPathDetails = Effect.fn("SetupOperation.readSkillPathDetails")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  let anchor = dirname(path);
  while (!(yield* maybeStat(anchor))) {
    const parent = dirname(anchor);
    if (parent === anchor) return yield* new RecoveryInvalid({ detail: `No parent for ${path}` });
    anchor = parent;
  }
  const physicalPath = yield* links.realPathNative(anchor);
  const parent = yield* links.identity.lstat(physicalPath);
  if (parent.type !== "Directory")
    return yield* new RecoveryInvalid({ detail: `Unsafe parent for ${path}` });
  const info = yield* maybeStat(path);
  const markerInfo =
    info?.type === "Directory" ? yield* maybeStat(join(path, ".skit-ownership.json")) : undefined;
  const marker =
    markerInfo?.type === "File"
      ? yield* fs.readFileString(join(path, ".skit-ownership.json"))
      : null;
  const markerMode = markerInfo
    ? (yield* links.lstat(join(path, ".skit-ownership.json"))).mode
    : null;
  return {
    path,
    anchor: { path: anchor, physicalPath, dev: parent.dev, ino: parent.ino },
    entry: info
      ? {
          dev: info.dev,
          ino: info.ino,
          type: info.type,
          hash: yield* recoveryFingerprint(path),
          unstampedHash: yield* recoveryFingerprint(path, "exclude"),
          marker,
          markerType: markerInfo?.type ?? null,
          markerMode,
          linkTarget: info.type === "SymbolicLink" ? yield* fs.readLink(path) : null,
        }
      : null,
  };
});

/** Capture setup's inverse inputs once under its existing writer, before settings or intent effects. */
export const beginSetupOperation = Effect.fn("SetupOperation.begin")(function* (
  approval: SetupApproval,
  initial: LibraryState,
  projecting: boolean,
  installedNames: readonly string[],
) {
  const store = yield* LibraryStore;
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const settings = yield* MachineSettings.read(store.home);
  const directory = approval.removals.operationDirectory;
  const targets = projecting ? yield* activeInstallDestinations(approval.setup.inventory) : [];
  const possibleTargets = projecting ? (["agents", "claude"] as const) : [];
  const installedSkillPaths = new Set(
    (approval.changes ?? [])
      .filter(
        (fact) =>
          fact.status === "incoming-update" ||
          fact.metadataChanged ||
          (fact.status !== "native-delete" &&
            approval.versionChoices?.some((choice) => choice.skillId === fact.skillId)),
      )
      .map((fact) => resolve(fact.path)),
  );
  for (const target of targets)
    for (const name of installedNames)
      installedSkillPaths.add(
        join(skillsDirectoryFor(target, { kind: "global" }, approval.setup.inventory), name),
      );
  const paths = new Set(approval.removals.entries.map((entry) => resolve(entry.path)));
  if (projecting) {
    const intent = deviceInstallationIntent(initial);
    const boundIds = new Set(
      intent.globals.flatMap((global) => enabledSkillIds(initial, global.enabled)),
    );
    const names = new Set([
      ...initial.skills.filter((skill) => boundIds.has(skill.skill_id)).map((skill) => skill.name),
      ...[...approval.bindings, ...approval.ownership]
        .filter((copy) => copy.duplicateAction !== "retain-only")
        .map((copy) => copy.name),
    ]);
    for (const installedSkill of initial.installed_skills) paths.add(resolve(installedSkill.path));
    for (const target of possibleTargets)
      for (const name of names)
        paths.add(
          join(skillsDirectoryFor(target, { kind: "global" }, approval.setup.inventory), name),
        );
    for (const copy of [...approval.bindings, ...approval.ownership]) {
      if (copy.duplicateAction === "retain-only") continue;
      paths.add(resolve(copy.sourcePath));
      for (const alias of copy.approvedSymlinks ?? []) paths.add(resolve(alias.path));
      for (const entry of copy.approvedCopies ?? []) paths.add(resolve(entry.path));
    }
  }
  const files = yield* Effect.forEach([...paths].sort(), readSkillPathDetails);
  let expectedIntent = setupIntent(initial);
  let expectedInstalledSkills = structuredClone(initial.installed_skills);
  let expectedSettings = setupDiscoverySettings(settings);
  let expectedMachineId = settings.machineId;
  yield* ensureRecoveryOperation(store.home, directory);
  yield* writeJsonExclusive(join(directory, "setup.json"), {
    schemaVersion: 2,
    kind: "setup",
    planId: approval.planId,
    before: expectedIntent,
    installedSkills: expectedInstalledSkills,
    settings: expectedSettings,
    machineId: settings.machineId ?? null,
    targets: targets.map((target) => ({
      target,
      root: skillsDirectoryFor(target, { kind: "global" }, approval.setup.inventory),
    })),
    installedSkillPaths: [...installedSkillPaths].sort(),
    files,
  } satisfies typeof Operation.Type);
  const changes = join(directory, "changes");
  yield* fs.makeDirectory(changes, { mode: 0o700 });
  if ((yield* links.identity.lstat(changes)).type !== "Directory")
    return yield* new RecoveryInvalid({ detail: "Redirected setup changes" });
  let sequence = 0;
  const writeChange = Effect.fn("SetupOperation.recordChange")(
    function* (
      change:
        | Omit<typeof LibraryChange.Type, "schemaVersion" | "sequence">
        | Omit<typeof SettingsChange.Type, "schemaVersion" | "sequence">,
    ) {
      const step = {
        ...change,
        schemaVersion: change.kind === "library" ? (2 as const) : (1 as const),
        sequence: ++sequence,
      };
      const key = String(step.sequence).padStart(8, "0");
      const path = join(changes, `${key}.json`);
      yield* writeJsonExclusive(path, step);
      return { sequence: step.sequence, digest: hashParts([yield* fs.readFileString(path)]) };
    },
    (effect) => effect.pipe(Effect.provideService(FileSystem.FileSystem, fs)),
  );
  const markSaved = Effect.fn("SetupOperation.markSaved")(
    function* (changeRecord: { sequence: number; digest: Digest }) {
      yield* writeJsonExclusive(
        join(changes, `${String(changeRecord.sequence).padStart(8, "0")}.published.json`),
        { schemaVersion: 1, sequence: changeRecord.sequence, digest: changeRecord.digest },
      );
    },
    (effect) => effect.pipe(Effect.provideService(FileSystem.FileSystem, fs)),
  );
  let pendingSettings:
    | {
        sequence: number;
        digest: Digest;
        after: SetupDiscoverySettings;
        machineId: MachineId | undefined;
      }
    | undefined;
  return {
    operationId: basename(directory),
    directory,
    recordSettings: Effect.fn("SetupOperation.recordSettings")(function* (
      before: MachineSettingsSnapshot,
      after: MachineSettingsSnapshot,
    ) {
      if (
        canonicalJson(setupDiscoverySettings(before)) !== canonicalJson(expectedSettings) ||
        before.machineId !== expectedMachineId
      )
        return yield* new LibraryChanged({ path: before.path });
      const changed = setupDiscoverySettings(after);
      const changeRecord = yield* writeChange({
        kind: "settings",
        before: setupDiscoverySettings(before),
        after: changed,
        machineId: after.machineId ?? null,
      });
      pendingSettings = { ...changeRecord, after: changed, machineId: after.machineId };
    }),
    settingsSaved: Effect.fn("SetupOperation.settingsSaved")(function* () {
      if (pendingSettings) {
        yield* markSaved(pendingSettings);
        expectedSettings = pendingSettings.after;
        expectedMachineId = pendingSettings.machineId;
        pendingSettings = undefined;
      }
    }),
    save: Effect.fn("SetupOperation.save")(function* (next: LibraryState, base: LibraryState) {
      const before = setupIntent(base);
      const after = setupIntent(next);
      const installedSkillsAfter = structuredClone(next.installed_skills);
      const changed =
        canonicalJson(before) !== canonicalJson(after) ||
        canonicalJson(base.installed_skills) !== canonicalJson(next.installed_skills);
      const changeRecord = changed
        ? yield* writeChange({
            kind: "library",
            beforeRevision: libraryStateRevision(base),
            afterRevision: libraryStateRevision(next),
            before,
            after,
            installedSkillsBefore: structuredClone(base.installed_skills),
            installedSkillsAfter: installedSkillsAfter,
          })
        : undefined;
      yield* store.save(next, base);
      if (changeRecord) yield* markSaved(changeRecord);
      expectedIntent = after;
      expectedInstalledSkills = installedSkillsAfter;
    }),
    complete: Effect.fn("SetupOperation.complete")(
      function* () {
        yield* writeJsonExclusive(join(directory, "complete.json"), {
          schemaVersion: 2,
          intent: expectedIntent,
          settings: expectedSettings,
          installedSkills: expectedInstalledSkills,
        } satisfies typeof Completion.Type);
      },
      (effect) => effect.pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    ),
  };
});

/** Decode complete immutable records; an unacknowledged last publication stays explicitly uncertain. */
export const inspectSetupOperation = Effect.fn("SetupOperation.inspect")(function* (
  home: string,
  operationId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const directory = yield* recoveryOperationPath(home, operationId);
  const read = <S extends Schema.Top & { readonly DecodingServices: never }>(
    name: string,
    schema: S,
  ) =>
    Effect.gen(function* () {
      const path = join(directory, name);
      if ((yield* links.identity.lstat(path)).type !== "File")
        return yield* new RecoveryInvalid({ detail: `Redirected setup record ${path}` });
      const raw = yield* fs.readFileString(path);
      const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(raw).pipe(
        Effect.mapError(() => new RecoveryInvalid({ detail: `Invalid setup record ${path}` })),
      );
      return { value, digest: hashParts([raw]) };
    });
  const operation = (yield* read("setup.json", StoredOperation)).value;
  const changes: { change: typeof StoredChange.Type; saved: boolean }[] = [];
  const changesPath = join(directory, "changes");
  if (yield* maybeStat(changesPath)) {
    if ((yield* links.identity.lstat(changesPath)).type !== "Directory")
      return yield* new RecoveryInvalid({ detail: "Redirected setup changes directory" });
    const names = (yield* fs.readDirectory(changesPath)).sort();
    for (const ack of names.filter((name) => /^\d{8}\.published\.json$/.test(name))) {
      if (!names.includes(ack.replace(".published.json", ".json")))
        return yield* new RecoveryInvalid({
          detail: "Setup save confirmation is missing its change record",
        });
    }
    for (const name of names.filter((name) => /^\d{8}\.json$/.test(name))) {
      const record = yield* read(join("changes", name), StoredChange);
      const change = record.value;
      if (
        name !== `${String(change.sequence).padStart(8, "0")}.json` ||
        change.sequence !== changes.length + 1
      )
        return yield* new RecoveryInvalid({ detail: "Out-of-order setup changes" });
      const ack = join("changes", name.replace(/\.json$/, ".published.json"));
      let saved = false;
      if (yield* maybeStat(join(directory, ack))) {
        const confirmation = (yield* read(ack, SaveConfirmation)).value;
        if (confirmation.sequence !== change.sequence || confirmation.digest !== record.digest)
          return yield* new RecoveryInvalid({
            detail: "Setup save confirmation differs from its change",
          });
        saved = true;
      }
      changes.push({ change, saved });
    }
  }
  const complete = (yield* maybeStat(join(directory, "complete.json")))
    ? (yield* read("complete.json", StoredCompletion)).value
    : undefined;
  let intent = operation.before;
  let settings = operation.settings;
  let installedSkills = operation.installedSkills;
  for (const [index, { change, saved }] of changes.entries()) {
    if (!saved && (index !== changes.length - 1 || complete))
      return yield* new RecoveryInvalid({
        detail: "Setup continued past an unconfirmed save",
      });
    if (change.kind === "library") {
      if (
        canonicalJson(change.before) !== canonicalJson(intent) ||
        canonicalJson(change.installedSkillsBefore) !== canonicalJson(installedSkills)
      )
        return yield* new RecoveryInvalid({
          detail: "Setup intent records do not form a continuous operation",
        });
      intent = change.after;
      installedSkills = change.installedSkillsAfter;
    } else {
      if (canonicalJson(change.before) !== canonicalJson(settings))
        return yield* new RecoveryInvalid({
          detail: "Setup settings records do not form a continuous operation",
        });
      settings = change.after;
    }
  }
  if (
    complete &&
    (canonicalJson(complete.intent) !== canonicalJson(intent) ||
      canonicalJson(complete.settings) !== canonicalJson(settings) ||
      canonicalJson(complete.installedSkills) !== canonicalJson(installedSkills))
  )
    return yield* new RecoveryInvalid({
      detail: "Setup completion differs from its recorded publications",
    });
  return { directory, operation, changes, complete };
});
