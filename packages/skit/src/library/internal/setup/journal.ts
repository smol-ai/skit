// The journal setups wrote under removed/<operationId>/ before state.json recorded operations:
// setup.json, changes/ and complete.json. Read only, for undo; such a setup is never resumed.

import { dirname, join, resolve } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { AbsoluteDevicePath, InstalledSkill } from "../../device-state.js";
import {
  FileIdentityNumber,
  LegacyFileIdentityNumber,
  LinkStat,
} from "../../../platform/link-stat.js";
import { canonicalJson } from "../../../shared/json.js";
import { Hash } from "../../../shared/hash.js";
import { InstallDestination } from "../../../installed-skills/destination.js";
import { hashParts } from "../../../artifact/descriptor.js";
import { MachineId } from "../../entity-ids.js";
import { SetupIntent } from "./intent.js";
import * as MachineSettings from "../../machine-settings.js";
import { recoveryOperationPath } from "../recovery/moves.js";
import { recoveryFingerprint } from "../recovery/evidence.js";
import { RecoveryInvalid } from "../../recovery-facts.js";
const SetupDiscoverySettings = MachineSettings.SetupDiscoverySettings;

const DevicePath = AbsoluteDevicePath.check(
  Schema.makeFilter((path) => resolve(path) === path, {
    message: "Expected a normalized absolute device path",
  }),
);
/** File evidence for one saved format of device and inode numbers. */
const fileEvidence = <Number extends Schema.Codec<bigint, unknown>>(number: Number) => {
  const Identity = { dev: number, ino: number };
  return Schema.Struct({
    path: DevicePath,
    anchor: Schema.Struct({
      path: DevicePath,
      physicalPath: DevicePath,
      ...Identity,
    }),
    entry: Schema.NullOr(
      Schema.Struct({
        ...Identity,
        type: Schema.String,
        hash: Hash,
        unstampedHash: Hash,
        marker: Schema.NullOr(Schema.String),
        markerType: Schema.optionalKey(Schema.NullOr(Schema.String)),
        markerMode: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        linkTarget: Schema.NullOr(Schema.String),
      }),
    ),
  });
};
// v3 saves device and inode numbers as text so they stay exact; v2 saved JSON numbers.
const FileEvidence = fileEvidence(FileIdentityNumber);
const NumericFileEvidence = fileEvidence(LegacyFileIdentityNumber);
const OperationFields = {
  kind: Schema.Literal("setup"),
  planId: Hash,
  settings: SetupDiscoverySettings,
  machineId: Schema.NullOr(MachineId),
  targets: Schema.Array(Schema.Struct({ target: InstallDestination, root: DevicePath })),
};
const OperationVersionFields = {
  before: SetupIntent,
  installedSkills: Schema.Array(InstalledSkill),
  installedSkillPaths: Schema.optionalKey(Schema.Array(DevicePath)),
};
const Operation = Schema.Struct({
  ...OperationFields,
  ...OperationVersionFields,
  schemaVersion: Schema.Literal(3),
  files: Schema.Array(FileEvidence),
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
  hash: Hash,
});
const Completion = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  intent: SetupIntent,
  settings: SetupDiscoverySettings,
  installedSkills: Schema.Array(InstalledSkill),
});

const StoredOperation = Schema.Union([
  Schema.Struct({
    ...OperationFields,
    ...OperationVersionFields,
    schemaVersion: Schema.Literal(2),
    files: Schema.Array(NumericFileEvidence),
  }),
  Operation,
]);
const StoredChange = Schema.Union([LibraryChange, SettingsChange]);

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
        return yield* new RecoveryInvalid({
          detail: `Redirected setup record ${path}`,
        });
      const raw = yield* fs.readFileString(path);
      const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(raw).pipe(
        Effect.mapError(() => new RecoveryInvalid({ detail: `Invalid setup record ${path}` })),
      );
      return { value, hash: hashParts([raw]) };
    });
  const operation = (yield* read("setup.json", StoredOperation)).value;
  const changes: { change: typeof StoredChange.Type; saved: boolean }[] = [];
  const changesPath = join(directory, "changes");
  if (yield* maybeStat(changesPath)) {
    if ((yield* links.identity.lstat(changesPath)).type !== "Directory")
      return yield* new RecoveryInvalid({
        detail: "Redirected setup changes directory",
      });
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
        return yield* new RecoveryInvalid({
          detail: "Out-of-order setup changes",
        });
      const ack = join("changes", name.replace(/\.json$/, ".published.json"));
      let saved = false;
      if (yield* maybeStat(join(directory, ack))) {
        const confirmation = (yield* read(ack, SaveConfirmation)).value;
        if (confirmation.sequence !== change.sequence || confirmation.hash !== record.hash)
          return yield* new RecoveryInvalid({
            detail: "Setup save confirmation differs from its change",
          });
        saved = true;
      }
      changes.push({ change, saved });
    }
  }
  const complete = (yield* maybeStat(join(directory, "complete.json")))
    ? (yield* read("complete.json", Completion)).value
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
