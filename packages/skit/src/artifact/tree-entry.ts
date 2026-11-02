import { Schema } from "effect";

/**
 * One entry of a tree: a directory, a file with its mode and bytes, or a symlink with its target.
 * Paths are relative and use `/`. It holds no platform code, so the Registry Worker can decode it.
 */
export const TreeEntry = Schema.Union([
  Schema.Struct({ path: Schema.String, kind: Schema.Literal("directory") }),
  Schema.Struct({
    path: Schema.String,
    kind: Schema.Literal("file"),
    mode: Schema.Literals([0o644, 0o755]),
    bytes: Schema.Uint8Array,
  }),
  Schema.Struct({ path: Schema.String, kind: Schema.Literal("symlink"), target: Schema.String }),
]);
export type TreeEntry = typeof TreeEntry.Type;
