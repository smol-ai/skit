import { RecoveryInvalid, recoveryFingerprint as fingerprint } from "./recovery-evidence.js";
export { RecoveryInvalid } from "./recovery-evidence.js";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import {
  deterministicTreeHash,
  Digest,
  LinkStat,
  LibraryStore,
  canonicalJson,
  inspectOwnershipMarker,
  type InstalledSkill,
  type LibraryStateReadError,
  pathIsWithin,
  withLibraryWriterLock,
  writeJsonExclusive,
} from "@smolai/skit-core";
import { PlanIsStale } from "../library/failures.js";
import { leavePnpmSkill } from "../projection/pnpm-skills.js";

const Identity = Schema.Struct({ path: Schema.String, dev: Schema.Number, ino: Schema.Number });
const EntryFields = {
  name: Schema.String,
  path: Schema.String,
  recoveryPath: Schema.String,
  type: Schema.Literals(["Directory", "SymbolicLink"]),
  dev: Schema.Number,
  ino: Schema.Number,
  linkTarget: Schema.optionalKey(Schema.String),
  observedHash: Schema.optionalKey(Schema.String),
};
const RecoveryEntry = Schema.Struct({
  ...EntryFields,
  contentHash: Digest,
  approvedMarker: Schema.optionalKey(Schema.String),
  parent: Identity,
});
interface RecoveryEntry extends Schema.Schema.Type<typeof RecoveryEntry> {}
const LegacyEntry = Schema.Struct({ ...EntryFields, moved: Schema.Boolean });
const MoveRecord = Schema.Union([
  Schema.Struct({ schemaVersion: Schema.Literal(1), entries: Schema.Array(LegacyEntry) }),
  Schema.Struct({ schemaVersion: Schema.Literal(2), entries: Schema.Array(RecoveryEntry) }),
]);

export const RecoveryFact = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  recoveryPath: Schema.String,
  type: Schema.Literals(["Directory", "SymbolicLink"]),
  status: Schema.Literals(["saved", "at-original", "missing", "conflict"]),
  reason: Schema.String,
});
export const RecoveryInspection = Schema.Struct({
  operationId: Schema.String,
  directory: Schema.String,
  planId: Digest,
  entries: Schema.Array(RecoveryFact),
  legacy: Schema.Boolean,
});

export interface RecoveryMoveRequest {
  readonly name: string;
  readonly path: string;
  /** Required for directories; links are moved without touching their target's bytes. */
  readonly observedHash?: string;
  readonly approvedLink?: {
    readonly dev: number;
    readonly ino: number;
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
    { marker: string; check: Effect.Effect<void, PlanIsStale | LibraryStateReadError> }
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
    if (info.type !== "Directory" && info.type !== "SymbolicLink") return yield* new PlanIsStale();
    const linkTarget = info.type === "SymbolicLink" ? yield* fs.readLink(path) : undefined;
    if (
      request.approvedLink &&
      (info.type !== "SymbolicLink" ||
        info.dev !== request.approvedLink.dev ||
        info.ino !== request.approvedLink.ino ||
        linkTarget !== request.approvedLink.linkTarget)
    )
      return yield* new PlanIsStale();
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
      ...(info.type === "Directory" && request.observedHash !== undefined
        ? { observedHash: request.observedHash }
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
  requests: readonly { name: string; projection: InstalledSkill }[],
  operationDirectory?: string,
) {
  const store = yield* LibraryStore;
  const fs = yield* FileSystem.FileSystem;
  const owned = new Map<
    string,
    { marker: string; check: Effect.Effect<void, PlanIsStale | LibraryStateReadError> }
  >();
  const moves: RecoveryMoveRequest[] = [];
  for (const request of requests) {
    const expected = structuredClone(request.projection);
    const path = resolve(expected.path);
    const check = Effect.gen(function* () {
      const state = yield* store.load;
      const current = state.installed_skills.find(
        (projection) => projection.installed_skill_id === expected.installed_skill_id,
      );
      if (canonicalJson(current ?? null) !== canonicalJson(expected))
        return yield* new PlanIsStale();
    });
    yield* check;
    const observed = yield* inspectOwnershipMarker(path);
    if (
      observed.kind !== "valid" ||
      observed.marker.installed_skill_id !== expected.installed_skill_id ||
      observed.marker.skill_id !== expected.skill_id ||
      observed.marker.skill_version_id !== expected.skill_version_id ||
      observed.marker.expected_digest !== expected.expected_digest
    )
      return yield* new PlanIsStale();
    const marker = yield* fs.readFileString(join(path, ".skit-ownership.json"));
    owned.set(path, { marker, check });
    moves.push({
      name: request.name,
      path,
      observedHash: yield* deterministicTreeHash(path),
    });
  }
  return yield* prepareMoves(
    store.home,
    moves,
    operationDirectory ?? recoveryOperationDirectory(store.home),
    owned,
  );
});

export type PreparedRecoveryMoves = Effect.Success<ReturnType<typeof prepareRecoveryMoves>>;

const applyRecoveryMoves = Effect.fn("RecoveryMoves.apply")(
  function* (
    home: string,
    recoveryDirectory: string,
    entries: readonly RecoveryEntry[],
    checkRegistered: Effect.Effect<void, PlanIsStale | LibraryStateReadError>,
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
        return yield* new PlanIsStale();
      if (entry.type !== "Directory") return;
      const hash = yield* Effect.result(deterministicTreeHash(entry.path));
      const marker = yield* fs
        .readFileString(join(entry.path, ".skit-ownership.json"))
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(undefined)
              : Effect.fail(new PlanIsStale()),
          ),
        );
      if (
        hash._tag === "Failure" ||
        hash.success !== entry.observedHash ||
        marker !== entry.approvedMarker
      )
        return yield* new PlanIsStale();
    });
    for (const entry of entries) yield* checkApproved(entry);
    if (!entries.length) return;
    yield* ensureRecoveryOperation(home, dirname(recoveryDirectory));
    yield* fs.makeDirectory(recoveryDirectory, { mode: 0o700 });
    // Write once, exclusively, before any move. Filesystem evidence supplies progress.
    yield* writeJsonExclusive(join(recoveryDirectory, "receipt.json"), {
      schemaVersion: 2,
      entries,
    });
    for (const entry of entries) {
      yield* checkApproved(entry);
      yield* fs.rename(entry.path, entry.recoveryPath);
    }
  },
  (effect, home) => withLibraryWriterLock(home, effect),
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
  let legacy = false;
  const paths = new Set<string>();
  for (const batch of batches) {
    yield* checkedDirectory(batch);
    evidence.push({ batch, identity: yield* links.identity.lstat(batch) });
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
        (entry.type === "Directory" && entry.observedHash === undefined)
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
          matches = normalized._tag === "Success" && normalized.success === entry.observedHash;
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
      witnesses.push(JSON.stringify({ parent, physicalParent, original, saved }));
      content.push({
        original: "hash" in original ? original.hash : undefined,
        saved: "hash" in saved ? saved.hash : undefined,
      });
    }
  }
  const planId = Digest.make(
    `sha256:${createHash("sha256")
      .update(JSON.stringify([operationId, evidence, facts]))
      .digest("hex")}`,
  );
  return {
    inspection: { operationId, directory, planId, entries: facts, legacy },
    witnesses,
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

/** Preview is passive; apply retains the reviewed evidence and revalidates under the writer. */
export const prepareRecoveryRestore = Effect.fn("Recovery.prepareRestore")(function* (
  home: string,
  operationId: string,
) {
  const observed = yield* readRecoveryOperation(home, operationId);
  const approvedId = observed.inspection.planId;
  return {
    summary: structuredClone(observed.inspection),
    apply: () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let current = yield* readRecoveryOperation(home, operationId);
        if (current.inspection.planId !== approvedId) return yield* new PlanIsStale();
        for (const [index, fact] of observed.inspection.entries.entries()) {
          if (fact.status !== "saved") continue;
          // Recheck the whole observed operation after each move. Never refresh consent for a changed entry.
          const refreshed = yield* readRecoveryOperation(home, operationId);
          if (refreshed.inspection.planId !== current.inspection.planId)
            return yield* new PlanIsStale();
          yield* fs.rename(fact.recoveryPath, fact.path);
          const after = yield* readRecoveryOperation(home, operationId);
          if (
            JSON.stringify(after.moveRecords) !== JSON.stringify(current.moveRecords) ||
            after.witnesses.length !== current.witnesses.length ||
            after.witnesses.some((witness, i) => i !== index && witness !== current.witnesses[i]) ||
            after.inspection.entries[index]?.status !== "at-original" ||
            after.content[index]?.original !== current.content[index]?.saved
          )
            return yield* new PlanIsStale();
          current = after;
        }
        return current.inspection;
      }).pipe((effect) => withLibraryWriterLock(home, effect)),
  };
});
