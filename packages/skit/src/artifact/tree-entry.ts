import { Schema } from "effect";

/**
 * One entry of a tree: a directory, a file with its mode and bytes, or a symlink with its target.
 * Paths are relative and use `/`. It holds no platform code, so the Registry Worker can decode it.
 */
/** The file variant of TreeEntry, shared by history, merging, and sync. */
export const TreeFile = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literal("file"),
  mode: Schema.Literals([0o644, 0o755]),
  bytes: Schema.Uint8Array,
});
export namespace TreeFile {
  export interface Type extends Schema.Schema.Type<typeof TreeFile> {}
}
export type TreeFile = TreeFile.Type;

export const TreeDirectory = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literal("directory"),
});
export const TreeSymlink = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literal("symlink"),
  target: Schema.String,
});

export const TreeEntry = Schema.Union([TreeDirectory, TreeFile, TreeSymlink]);
export type TreeEntry = typeof TreeEntry.Type;
