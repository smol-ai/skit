// Moving folders aside during setup: a receipt under removed/<operationId>/, written before any
// move, then each move, each checked against its recorded evidence first.

import { Effect, FileSystem, Option, Schema } from "effect";
import { basename, join, resolve } from "node:path";
import { InvalidLibraryState } from "../../failures.js";
import { writeJsonExclusive } from "../../../platform/atomic-write.js";
import { FileIdentityNumber, LinkStat } from "../../../platform/link-stat.js";
import { leavePnpmSkill } from "../../../installed-skills/pnpm-skills.js";
import type { OperationId } from "../../entity-ids.js";
import {
  absentUnder,
  holdsEvidence,
  parentIsAsRecorded,
  recoveryEntryPath,
} from "../../folder-evidence.js";
import { LibraryWriter } from "../../store/library-store.js";
import type { FolderEvidence, LinkEvidence } from "../../store/state-schema.js";
import { Hash } from "../../../shared/hash.js";

/** One entry of a step's move receipt, in the format recovery reads (`removed/<id>/<batch>/`). */
const ReceiptEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  recoveryPath: Schema.String,
  type: Schema.Literals(["Directory", "SymbolicLink"]),
  dev: FileIdentityNumber,
  ino: FileIdentityNumber,
  linkTarget: Schema.optionalKey(Schema.String),
  currentHash: Schema.optionalKey(Hash),
  contentHash: Hash,
  approvedMarker: Schema.optionalKey(Schema.String),
  parent: Schema.Struct({ path: Schema.String, dev: FileIdentityNumber, ino: FileIdentityNumber }),
});
const Receipt = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  entries: Schema.Array(ReceiptEntry),
});

const removedPath = (home: string) => join(resolve(home), "removed");
/**
 * A step's recovery directory, fixed by the operation, the step and, for a Manage step, the
 * selection, so a re-run finds it.
 */
export const recoveryDirectory = (
  home: string,
  operationId: OperationId,
  step: number,
  selection?: number,
) =>
  join(
    removedPath(home),
    operationId,
    selection === undefined ? `step-${step + 1}` : `step-${step + 1}-${selection + 1}`,
  );

const receiptEntry = (
  evidence: FolderEvidence | LinkEvidence,
  recoveryPath: string,
): typeof ReceiptEntry.Type => ({
  name: basename(evidence.path),
  path: evidence.path,
  recoveryPath,
  type: evidence._tag,
  dev: evidence.dev,
  ino: evidence.ino,
  contentHash: evidence.contentHash,
  parent: evidence.parent,
  ...(evidence._tag === "SymbolicLink"
    ? { linkTarget: evidence.linkTarget }
    : {
        currentHash: evidence.treeHash,
        ...Option.match(evidence.marker, {
          onNone: () => ({}),
          onSome: (approvedMarker) => ({ approvedMarker }),
        }),
      }),
});

/** Create a recovery container, refusing one that is not a plain directory. */
const recoveryContainer = Effect.fn("Library.setup.recoveryContainer")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const exists = yield* fs.exists(path);
  if (!exists) yield* fs.makeDirectory(path, { mode: 0o700 });
  if ((yield* links.identity.lstat(path)).type !== "Directory")
    return yield* new InvalidLibraryState({ path, detail: "recovery directory is redirected" });
});

/** Every folder moved aside into `directory`, or the first that is not as recorded. */
export type Moved =
  | { readonly _tag: "Moved"; readonly directory: string }
  | { readonly _tag: "Differs"; readonly folder: FolderEvidence | LinkEvidence };

/**
 * Move each folder aside into the step's recovery directory, writing the receipt first. Safe to
 * repeat: a folder already moved, its saved copy intact, is left as it is; the receipt, fixed by the
 * recorded evidence, may already exist exactly as written.
 */
export const moveAside = Effect.fn("Library.setup.moveAside")(function* (
  operationId: OperationId,
  directory: string,
  folders: readonly (FolderEvidence | LinkEvidence)[],
) {
  const { home } = yield* LibraryWriter;
  const fs = yield* FileSystem.FileSystem;
  if (!folders.length) return { _tag: "Moved", directory } satisfies Moved;
  const entries = folders.map((folder, index) => ({
    folder,
    saved: recoveryEntryPath(directory, index, folder.path),
  }));
  const pending: typeof entries = [];
  for (const entry of entries) {
    const atOriginal =
      (yield* parentIsAsRecorded(entry.folder.path, entry.folder.parent)) &&
      (yield* holdsEvidence(entry.folder, entry.folder.path)) &&
      !(yield* fs.exists(entry.saved));
    if (atOriginal) {
      pending.push(entry);
      continue;
    }
    const moved =
      (yield* absentUnder(entry.folder.path, entry.folder.parent)) &&
      (yield* holdsEvidence(entry.folder, entry.saved));
    if (!moved) return { _tag: "Differs", folder: entry.folder } satisfies Moved;
  }
  for (const path of [removedPath(home), join(removedPath(home), operationId), directory])
    yield* recoveryContainer(path);
  const receipt = yield* Schema.encodeEffect(Receipt)({
    schemaVersion: 3,
    entries: entries.map(({ folder, saved }) => receiptEntry(folder, saved)),
  });
  const receiptPath = join(directory, "receipt.json");
  yield* writeJsonExclusive(receiptPath, receipt).pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "AlreadyExists"
        ? Effect.flatMap(fs.readFileString(receiptPath), (text) =>
            text === `${JSON.stringify(receipt, null, 2)}\n` ? Effect.void : Effect.fail(error),
          )
        : Effect.fail(error),
    ),
  );
  for (const { folder, saved } of pending) {
    yield* leavePnpmSkill(folder.path);
    // Recheck just before the move: the receipt write may have taken a while.
    if (
      !(yield* parentIsAsRecorded(folder.path, folder.parent)) ||
      !(yield* holdsEvidence(folder, folder.path))
    )
      return { _tag: "Differs", folder } satisfies Moved;
    yield* fs.rename(folder.path, saved);
  }
  return { _tag: "Moved", directory } satisfies Moved;
});
