import { RecoveryInvalid, recoveryFingerprint as fingerprint } from "./evidence.js";
export { RecoveryInvalid } from "./evidence.js";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Effect, FileSystem, Schema, SchemaGetter } from "effect";
import { deterministicTreeHash } from "../../../artifact/skit.js";
import { Hash } from "../../../vocabulary.js";
import {
  LinkStat,
  FileIdentityNumber,
  LegacyFileIdentityNumber,
} from "../../../platform/link-stat.js";
import { loadLibrary, type LibraryStateReadError } from "../../store/library-store.js";
import { canonicalJson } from "../../../shared/json.js";
import { inspectOwnershipMarker } from "../../../install/files.js";
import { type InstalledSkill } from "../../device-state.js";
import { pathIsWithin } from "../../../platform/path-identity.js";
import { withLock as withHomeLock } from "../../../platform/home-lock.js";
import { writeJsonExclusive } from "../../../platform/atomic-write.js";
import { StalePlan } from "../../library-plan.js";
import { leavePnpmSkill } from "../../../install/pnpm-skills.js";

/** Entry shapes for one saved format of device and inode numbers. */
const recordSchemas = <Number extends Schema.Codec<bigint, unknown>>(number: Number) => {
  const Identity = Schema.Struct({ path: Schema.String, dev: number, ino: number });
  const EntryFields = {
    name: Schema.String,
    path: Schema.String,
    recoveryPath: Schema.String,
    type: Schema.Literals(["Directory", "SymbolicLink"]),
    dev: number,
    ino: number,
    linkTarget: Schema.optionalKey(Schema.String),
    currentHash: Schema.optionalKey(Schema.String),
  };
  const Entry = Schema.Struct({
    ...EntryFields,
    contentHash: Hash,
    approvedMarker: Schema.optionalKey(Schema.String),
    parent: Identity,
  });
  return { EntryFields, Entry };
};
// v3 saves device and inode numbers as text so they stay exact; v1 and v2 saved JSON numbers.
const current = recordSchemas(FileIdentityNumber);
const numeric = recordSchemas(LegacyFileIdentityNumber);
const decoded = recordSchemas(Schema.BigInt);
const RecoveryEntry = current.Entry;
interface RecoveryEntry extends Schema.Schema.Type<typeof RecoveryEntry> {}
// 0.3.0 wrote v1 records, where the hash of a moved folder was `observedHash`.
const { currentHash: _currentHash, ...LegacyFields } = numeric.EntryFields;
const LegacyEntry = Schema.Struct({
  ...LegacyFields,
  observedHash: Schema.optionalKey(Schema.String),
  moved: Schema.Boolean,
}).pipe(
  Schema.decodeTo(Schema.Struct({ ...decoded.EntryFields, moved: Schema.Boolean }), {
    decode: SchemaGetter.transform(({ observedHash, ...entry }) => ({
      ...entry,
      ...(observedHash === undefined ? {} : { currentHash: observedHash }),
    })),
    encode: SchemaGetter.forbidden(() => "v1 move records are decode-only"),
  }),
);
const CurrentMoveRecord = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  entries: Schema.Array(RecoveryEntry),
});
const MoveRecord = Schema.Union([
  Schema.Struct({ schemaVersion: Schema.Literal(1), entries: Schema.Array(LegacyEntry) }),
  Schema.Struct({ schemaVersion: Schema.Literal(2), entries: Schema.Array(numeric.Entry) }),
  CurrentMoveRecord,
]);

import { RecoveryFact } from "../../recovery-facts.js";
export { RecoveryFact, RecoveryInspection } from "../../recovery-facts.js";

export interface RecoveryMoveRequest {
  readonly name: string;
  readonly path: string;
  /** Required for directories; links are moved without touching their target's bytes. */
  readonly currentHash?: string;
  readonly approvedLink?: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly linkTarget: string;
  };
}

/** Allocation is passive: no directory exists until a batch applies. */
export const recoveryOperationDirectory = (home: string) =>
  join(resolve(home), "removed", randomUUID());

/** Capture approved files; mutation records stay private. */
const prepareMoves = Effect.fn("RecoveryMoves.prepare")(function* (
  home: string,
  requests: readonly RecoveryMoveRequest[],
  operationDirectory: string,
  owned: ReadonlyMap<
    string,
    { marker: string; check: Effect.Effect<void, StalePlan | LibraryStateReadError> }
  > = new Map(),
) {
  if (dirname(operationDirectory) !== join(resolve(home), "removed"))
    return yield* new RecoveryInvalid({
      detail: "Operation must belong to this Library's recovery directory",
    });
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const recoveryDirectory = join(operationDirectory, randomUUID());
  const entries: RecoveryEntry[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    const parentPath = yield* links.realPathNative(dirname(resolve(request.path)));
    const path = resolve(request.path);
    const physicalPath = join(parentPath, basename(path));
    if (seen.has(physicalPath)) continue;
    if (
      [...seen].some(
        (other) => pathIsWithin(other, physicalPath) || pathIsWithin(physicalPath, other),
      )
    )
      return yield* new RecoveryInvalid({ detail: "Overlapping recovery entries are unsafe" });
    seen.add(physicalPath);
    if (
      path === resolve(home) ||
      pathIsWithin(path, resolve(home)) ||
      pathIsWithin(join(resolve(home), "removed"), path)
    )
      return yield* new RecoveryInvalid({ detail: "Library storage cannot be displaced" });
    const info = yield* links.identity.lstat(path);
    if (info.type !== "Directory" && info.type !== "SymbolicLink")
      return yield* new StalePlan({ message: "The Library changed since this was previewed" });
    const linkTarget = info.type === "SymbolicLink" ? yield* fs.readLink(path) : undefined;
    if (
      request.approvedLink &&
      (info.type !== "SymbolicLink" ||
        info.dev !== request.approvedLink.dev ||
        info.ino !== request.approvedLink.ino ||
        linkTarget !== request.approvedLink.linkTarget)
    )
      return yield* new StalePlan({ message: "The Library changed since this was previewed" });
    const physicalHome = yield* links
      .realPathNative(home)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(resolve(home)) : Effect.fail(error),
        ),
      );
    if (
      physicalPath === physicalHome ||
      pathIsWithin(physicalPath, physicalHome) ||
      physicalPath === join(physicalHome, "removed") ||
      pathIsWithin(join(physicalHome, "removed"), physicalPath)
    )
      return yield* new RecoveryInvalid({ detail: "Recovery cannot displace its own storage" });
    const parent = yield* links.identity.lstat(parentPath);
    entries.push({
      name: request.name,
      path,
      recoveryPath: join(recoveryDirectory, `${entries.length + 1}-${basename(path)}`),
      type: info.type,
      dev: info.dev,
      ino: info.ino,
      parent: { path: parentPath, dev: parent.dev, ino: parent.ino },
      contentHash: yield* fingerprint(path),
      ...(owned.get(path) ? { approvedMarker: owned.get(path)?.marker } : {}),
      ...(linkTarget === undefined ? {} : { linkTarget }),
      ...(info.type === "Directory" && request.currentHash !== undefined
        ? { currentHash: request.currentHash }
        : {}),
    });
  }
  return {
    operationDirectory,
    recoveryDirectory,
    entries: entries.map(({ name, path, type }) => ({ name, path, type })),
    apply: () =>
      applyRecoveryMoves(
        home,
        recoveryDirectory,
        entries,
        Effect.forEach([...owned.values()], (approval) => approval.check, { discard: true }),
      ),
  };
});
/** Unmanaged copies never acquire authority to move an ownership marker. */
export const prepareRecoveryMoves = (
  home: string,
  requests: readonly RecoveryMoveRequest[],
  operationDirectory = recoveryOperationDirectory(home),
) => prepareMoves(home, requests, operationDirectory);

/** Preserve exactly reviewed, registered installed skills; marker text alone never grants ownership. */
export const prepareOwnedRecoveryMoves = Effect.fn("RecoveryMoves.prepareOwned")(function* (
  home: string,
  requests: readonly { name: string; installedSkill: InstalledSkill }[],
  operationDirectory?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const owned = new Map<
    string,
    { marker: string; check: Effect.Effect<void, StalePlan | LibraryStateReadError> }
  >();
  const moves: RecoveryMoveRequest[] = [];
  for (const request of requests) {
    const expected = structuredClone(request.installedSkill);
    const path = resolve(expected.path);
    const check = Effect.gen(function* () {
      const state = yield* loadLibrary(home);
      const current = state.installed_skills.find(
        (installedSkill) => installedSkill.installed_skill_id === expected.installed_skill_id,
      );
      if (canonicalJson(current ?? null) !== canonicalJson(expected))
        return yield* new StalePlan({ message: "The Library changed since this was previewed" });
    }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    yield* check;
    const observed = yield* inspectOwnershipMarker(path);
    if (
      observed.kind !== "valid" ||
      observed.marker.installed_skill_id !== expected.installed_skill_id ||
      observed.marker.skill_id !== expected.skill_id ||
      observed.marker.skill_version_id !== expected.skill_version_id ||
      observed.marker.expected_hash !== expected.expected_hash
    )
      return yield* new StalePlan({ message: "The Library changed since this was previewed" });
    const marker = yield* fs.readFileString(join(path, ".skit-ownership.json"));
    owned.set(path, { marker, check });
    moves.push({
      name: request.name,
      path,
      currentHash: yield* deterministicTreeHash(path),
    });
  }
  return yield* prepareMoves(
    home,
    moves,
    operationDirectory ?? recoveryOperationDirectory(home),
    owned,
  );
});

export type PreparedRecoveryMoves = Effect.Success<ReturnType<typeof prepareRecoveryMoves>>;

const applyRecoveryMoves = Effect.fn("RecoveryMoves.apply")(
  function* (
    home: string,
    recoveryDirectory: string,
    entries: readonly RecoveryEntry[],
    checkRegistered: Effect.Effect<void, StalePlan | LibraryStateReadError>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const links = yield* LinkStat;
    const checkApproved = Effect.fn("RecoveryMoves.checkApproved")(function* (
      entry: RecoveryEntry,
    ) {
      yield* checkRegistered;
      yield* leavePnpmSkill(entry.path);
      const current = yield* links.identity.lstat(entry.path);
      const physicalParent = yield* links.realPathNative(dirname(entry.path));
      const parent = yield* links.identity.lstat(physicalParent);
      if (
        parent.type !== "Directory" ||
        parent.dev !== entry.parent.dev ||
        parent.ino !== entry.parent.ino ||
        physicalParent !== entry.parent.path ||
        current.type !== entry.type ||
        current.dev !== entry.dev ||
        current.ino !== entry.ino ||
        (yield* fingerprint(entry.path)) !== entry.contentHash
      )
        return yield* new StalePlan({ message: "The Library changed since this was previewed" });
      if (entry.type !== "Directory") return;
      const hash = yield* Effect.result(deterministicTreeHash(entry.path));
      const marker = yield* fs
        .readFileString(join(entry.path, ".skit-ownership.json"))
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(undefined)
              : Effect.fail(
                  new StalePlan({ message: "The Library changed since this was previewed" }),
                ),
          ),
        );
      if (
        hash._tag === "Failure" ||
        hash.success !== entry.currentHash ||
        marker !== entry.approvedMarker
      )
        return yield* new StalePlan({ message: "The Library changed since this was previewed" });
    });
    for (const entry of entries) yield* checkApproved(entry);
    if (!entries.length) return;
    yield* ensureRecoveryOperation(home, dirname(recoveryDirectory));
    yield* fs.makeDirectory(recoveryDirectory, { mode: 0o700 });
    // Write once, exclusively, before any move. Filesystem evidence supplies progress.
    yield* writeJsonExclusive(
      join(recoveryDirectory, "receipt.json"),
      Schema.encodeSync(CurrentMoveRecord)({ schemaVersion: 3, entries }),
    );
    for (const entry of entries) {
      yield* checkApproved(entry);
      yield* fs.rename(entry.path, entry.recoveryPath);
    }
  },
  (effect, home) => withHomeLock(home, effect),
);

const missingStat = Effect.fn("Recovery.stat")(function* (path: string) {
  const links = yield* LinkStat;
  return yield* links.identity
    .lstat(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
});

/** No symlink may redirect a move record or archive container; the configured home may be an alias. */
const checkedDirectory = Effect.fn("Recovery.directory")(function* (path: string) {
  const links = yield* LinkStat;
  if ((yield* links.identity.lstat(path)).type !== "Directory")
    return yield* new RecoveryInvalid({ detail: `Expected a recovery directory at ${path}` });
});

/** Create only this Library's operation containers, checking each parent before descending. */
export const ensureRecoveryOperation = Effect.fn("Recovery.ensureOperation")(function* (
  home: string,
  directory: string,
) {
  if (
    dirname(directory) !== join(resolve(home), "removed") ||
    !/^[a-zA-Z0-9_-]+$/.test(basename(directory))
  )
    return yield* new RecoveryInvalid({ detail: "Invalid recovery operation directory" });
  const fs = yield* FileSystem.FileSystem;
  for (const path of [join(resolve(home), "removed"), directory]) {
    if (!(yield* missingStat(path))) yield* fs.makeDirectory(path, { mode: 0o700 });
    yield* checkedDirectory(path);
  }
});

/** Passive location validation shared by file recovery and setup's guarded inverse. */
export const recoveryOperationPath = Effect.fn("Recovery.operationPath")(function* (
  home: string,
  operationId: string,
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(operationId))
    return yield* new RecoveryInvalid({ detail: "Invalid operation identifier" });
  const links = yield* LinkStat;
  const removed = join(yield* links.realPathNative(home), "removed");
  yield* checkedDirectory(removed);
  const directory = join(removed, operationId);
  yield* checkedDirectory(directory);
  return directory;
});

const readRecoveryOperation = Effect.fn("Recovery.readOperation")(function* (
  home: string,
  operationId: string,
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(operationId))
    return yield* new RecoveryInvalid({ detail: "Invalid operation identifier" });
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const removed = join(yield* links.realPathNative(home), "removed");
  yield* checkedDirectory(removed);
  const directory = join(removed, operationId);
  yield* checkedDirectory(directory);
  const legacyMoveRecord = yield* missingStat(join(directory, "receipt.json"));
  const metadata: string[] = [];
  const names = legacyMoveRecord ? [] : (yield* fs.readDirectory(directory)).sort();
  for (const name of names.filter((name) => name === "setup.json" || name === "complete.json")) {
    const path = join(directory, name);
    if ((yield* links.identity.lstat(path)).type !== "File")
      return yield* new RecoveryInvalid({ detail: `Redirected setup evidence at ${path}` });
    metadata.push(yield* fs.readFileString(path));
  }
  const batches = legacyMoveRecord
    ? [directory]
    : names
        .filter((name) => name !== "setup.json" && name !== "complete.json")
        .map((id) => join(directory, id));
  const facts: (typeof RecoveryFact.Type)[] = [];
  const witnesses: string[] = [];
  const moveRecords: string[] = [...metadata];
  const content: { original: string | undefined; saved: string | undefined }[] = [];
  const evidence: unknown[] = [...metadata];
  const structure: unknown[] = [...metadata];
  const parents: string[] = [];
  let legacy = false;
  const paths = new Set<string>();
  for (const batch of batches) {
    yield* checkedDirectory(batch);
    const batchIdentity = { batch, identity: yield* links.identity.lstat(batch) };
    evidence.push(batchIdentity);
    structure.push({
      batch,
      identity: {
        dev: batchIdentity.identity.dev,
        ino: batchIdentity.identity.ino,
        type: batchIdentity.identity.type,
      },
    });
    const moveRecordPath = join(batch, "receipt.json");
    // A crash before the move record was written left no authorized moves in this batch.
    if (!(yield* missingStat(moveRecordPath))) continue;
    if ((yield* links.identity.lstat(moveRecordPath)).type !== "File")
      return yield* new RecoveryInvalid({
        detail: `Move record is not a regular file: ${moveRecordPath}`,
      });
    const raw = yield* fs.readFileString(moveRecordPath);
    const moveRecord = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MoveRecord))(
      raw,
    ).pipe(
      Effect.mapError(
        () => new RecoveryInvalid({ detail: `Invalid move record: ${moveRecordPath}` }),
      ),
    );
    evidence.push(raw);
    moveRecords.push(raw);
    structure.push(raw);
    legacy ||= moveRecord.schemaVersion === 1;
    for (const [index, storedEntry] of moveRecord.entries.entries()) {
      const expectedArchive = join(batch, `${index + 1}-${basename(storedEntry.path)}`);
      const logicalBatch = legacyMoveRecord
        ? join(resolve(home), "removed", operationId)
        : join(resolve(home), "removed", operationId, basename(batch));
      if (
        storedEntry.recoveryPath !== expectedArchive &&
        storedEntry.recoveryPath !==
          join(logicalBatch, `${index + 1}-${basename(storedEntry.path)}`)
      )
        return yield* new RecoveryInvalid({ detail: `Unsafe archive path in ${moveRecordPath}` });
      const entry = { ...storedEntry, recoveryPath: expectedArchive };
      if (
        !isAbsolute(entry.path) ||
        resolve(entry.path) !== entry.path ||
        entry.path === dirname(entry.path) ||
        entry.path === resolve(home) ||
        pathIsWithin(entry.path, resolve(home)) ||
        pathIsWithin(removed, entry.path) ||
        entry.recoveryPath !== join(batch, `${index + 1}-${basename(entry.path)}`) ||
        paths.has(entry.path) ||
        (entry.type === "SymbolicLink" && entry.linkTarget === undefined) ||
        (entry.type === "Directory" && entry.currentHash === undefined)
      )
        return yield* new RecoveryInvalid({
          detail: `Unsafe or incomplete entry in ${moveRecordPath}`,
        });
      paths.add(entry.path);
      const parentStat = yield* missingStat(dirname(entry.path));
      const parent = parentStat && {
        dev: parentStat.dev,
        ino: parentStat.ino,
        type: parentStat.type,
      };
      const physicalParent = parent ? yield* links.realPathNative(dirname(entry.path)) : undefined;
      const approvedParent =
        "parent" in entry ? entry.parent : parent && { ...parent, path: physicalParent };
      const safeParent =
        parent?.type === "Directory" &&
        physicalParent !== undefined &&
        physicalParent !== removed &&
        !pathIsWithin(removed, physicalParent) &&
        physicalParent === approvedParent?.path &&
        parent.dev === approvedParent?.dev &&
        parent.ino === approvedParent?.ino;
      const probe = Effect.fn("Recovery.probe")(function* (path: string) {
        const stat = yield* missingStat(path);
        if (!stat) return { exists: false, matches: false };
        const content = yield* Effect.result(fingerprint(path));
        const hash = content._tag === "Success" ? content.success : undefined;
        let matches =
          stat.type === entry.type &&
          stat.dev === entry.dev &&
          stat.ino === entry.ino &&
          hash !== undefined;
        if (matches && "contentHash" in entry) matches = hash === entry.contentHash;
        else if (matches && entry.type === "SymbolicLink")
          matches = (yield* fs.readLink(path)) === entry.linkTarget;
        else if (matches) {
          const normalized = yield* Effect.result(deterministicTreeHash(path));
          matches = normalized._tag === "Success" && normalized.success === entry.currentHash;
        }
        return { exists: true, matches, stat, hash };
      });
      const original = yield* probe(entry.path);
      const saved = yield* probe(entry.recoveryPath);
      evidence.push({ parent, physicalParent, original, saved });
      const status = !safeParent
        ? "conflict"
        : saved.matches && !original.exists
          ? "saved"
          : original.matches && !saved.exists
            ? "at-original"
            : !original.exists && !saved.exists
              ? "missing"
              : "conflict";
      const reason = !safeParent
        ? "Original parent is missing, replaced or redirected"
        : status === "saved"
          ? "Verified saved entry; original destination is free"
          : status === "at-original"
            ? "Verified entry is at its original path"
            : status === "missing"
              ? "Neither original nor saved entry exists"
              : original.exists && saved.matches
                ? "Original destination is occupied; preserve both entries"
                : "Saved or original entry differs from its move record";
      facts.push({
        name: entry.name,
        path: entry.path,
        recoveryPath: entry.recoveryPath,
        type: entry.type,
        status,
        reason,
      });
      // canonicalJson renders exact device and inode numbers; JSON.stringify cannot.
      witnesses.push(canonicalJson({ parent, physicalParent, original, saved }));
      parents.push(canonicalJson({ parent, physicalParent }));
      content.push({
        original: "hash" in original ? original.hash : undefined,
        saved: "hash" in saved ? saved.hash : undefined,
      });
    }
  }
  const planId = Hash.make(
    `sha256:${createHash("sha256")
      .update(canonicalJson([operationId, evidence, facts]))
      .digest("hex")}`,
  );
  return {
    inspection: { operationId, directory, planId, entries: facts, legacy },
    witnesses,
    parents,
    structure: canonicalJson(structure),
    moveRecords,
    content,
  };
});

export const inspectRecoveryOperation = Effect.fn("Recovery.inspect")(function* (
  home: string,
  operationId: string,
) {
  return (yield* readRecoveryOperation(home, operationId)).inspection;
});

export const listRecoveryOperations = Effect.fn("Recovery.list")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const removed = join(home, "removed");
  if (!(yield* missingStat(removed))) return [];
  yield* checkedDirectory(removed);
  return (yield* fs.readDirectory(removed)).sort();
});

/** Data captured by Library.plan, persisted before the restore runner can move an entry. */
export const captureRecoveryRestore = Effect.fn("Recovery.captureRestore")(function* (
  home: string,
  operationId: string,
) {
  const observed = yield* readRecoveryOperation(home, operationId);
  return {
    summary: observed.inspection,
    witnesses: observed.witnesses,
    parents: observed.parents,
    structure: observed.structure,
    content: observed.content.map((item) => ({
      ...(item.original === undefined ? {} : { original: item.original }),
      ...(item.saved === undefined ? {} : { saved: item.saved }),
    })),
  };
});

/** Accept the recorded observation or its exact restored entries; never refresh restore consent. */
export const restoreRecorded = Effect.fn("Recovery.restoreRecorded")(function* (
  home: string,
  program: import("../../store/state-schema.js").RecoveryRestore,
) {
  const fs = yield* FileSystem.FileSystem;
  const check = Effect.fn("Recovery.checkRecordedRestore")(function* () {
    const current = yield* readRecoveryOperation(home, program.summary.operationId);
    if (
      current.structure !== program.structure ||
      JSON.stringify(current.parents) !== JSON.stringify(program.parents) ||
      current.witnesses.length !== program.witnesses.length
    )
      return yield* new StalePlan({ message: "Recovery evidence changed since this was reviewed" });
    for (const [index, fact] of program.summary.entries.entries()) {
      if (current.witnesses[index] === program.witnesses[index]) continue;
      if (
        fact.status === "saved" &&
        current.inspection.entries[index]?.status === "at-original" &&
        current.content[index]?.original === program.content[index]?.saved
      )
        continue;
      return yield* new StalePlan({ message: `Recovery evidence changed at ${fact.path}` });
    }
    return current;
  });
  let current = yield* check();
  for (const [index, fact] of program.summary.entries.entries()) {
    if (fact.status !== "saved" || current.inspection.entries[index]?.status === "at-original")
      continue;
    current = yield* check();
    yield* fs.rename(fact.recoveryPath, fact.path);
    current = yield* check();
    if (current.inspection.entries[index]?.status !== "at-original")
      return yield* new StalePlan({ message: `Restored entry differs at ${fact.path}` });
  }
  return current.inspection;
});
