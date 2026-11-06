import { Effect, FileSystem, Schema } from "effect";
import { dirname, join } from "node:path";
import { FileIdentityNumber, LinkStat } from "../../../platform/link-stat.js";

import { recoveryFingerprint } from "../recovery/evidence.js";
import { RecoveryInvalid } from "../../recovery-facts.js";

const Identity = { dev: FileIdentityNumber, ino: FileIdentityNumber };
const Anchor = Schema.Struct({ path: Schema.String, physicalPath: Schema.String, ...Identity });
const Entry = Schema.Struct({
  ...Identity,
  type: Schema.String,
  hash: Schema.String,
  marker: Schema.NullOr(Schema.String),
  markerType: Schema.optionalKey(Schema.NullOr(Schema.String)),
  markerMode: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  linkTarget: Schema.NullOr(Schema.String),
});

/** A setup's original entry, including how that setup measured bytes without its marker. */
export const UndoFile = Schema.Struct({
  path: Schema.String,
  anchor: Anchor,
  entry: Schema.NullOr(
    Entry.pipe(
      Schema.fieldsAssign({
        unmarked: Schema.Struct({
          by: Schema.Literals(["fingerprint", "tree"]),
          hash: Schema.String,
        }),
      }),
    ),
  ),
});
export type UndoFile = typeof UndoFile.Type;

/** Exact evidence at review, staging, or a verified restored destination. */
export const UndoPath = Schema.Struct({
  path: Schema.String,
  anchor: Anchor,
  entry: Schema.NullOr(Entry.pipe(Schema.fieldsAssign({ unstampedHash: Schema.String }))),
});
export type UndoPath = typeof UndoPath.Type;
export const UndoAction = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["release-ownership", "restore", "remove-created"]),
  source: Schema.optionalKey(Schema.String),
  transfer: Schema.optionalKey(Schema.Literals(["move", "copy", "rebuild"])),
  /** Bound before a staged entry can be renamed into the destination. */
  after: Schema.optionalKey(UndoPath),
  staged: Schema.optionalKey(UndoPath),
});
export type UndoAction = typeof UndoAction.Type;

const maybeStat = Effect.fn("SetupUndo.stat")(function* (path: string) {
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
export const readSkillPathDetails = Effect.fn("SetupUndo.readSkillPathDetails")(function* (
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
