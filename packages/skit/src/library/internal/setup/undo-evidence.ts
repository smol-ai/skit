import { Schema } from "effect";
import { FileIdentityNumber } from "../../../platform/link-stat.js";

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
