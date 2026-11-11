import { gitInspectionFailure } from "./git-inspection-failure.js";
import type { TreeErrorReason } from "@smolai/skit-core/shared";
import { Match } from "effect";

const entryTypes = {
  File: "a file",
  Directory: "a directory",
  SymbolicLink: "a symbolic link",
  BlockDevice: "a block device",
  CharacterDevice: "a character device",
  FIFO: "a named pipe",
  Socket: "a socket",
  Unknown: "an unknown filesystem entry",
} satisfies Record<Extract<TreeErrorReason, { _tag: "RootNotDirectory" }>["entryType"], string>;

const escapedUnicodePath = (path: string): string =>
  JSON.stringify(path).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** Tree readers supply facts; this frontend describes the rejected content. */
export const treeFailure = Match.type<TreeErrorReason>().pipe(
  Match.tagsExhaustive({
    GitCommandFailed: ({ command, exitCode }) => `${command} exited with ${exitCode}`,
    GitInspectionFailed: ({ issue }) =>
      `Unable to evaluate Git ignore rules for Artifact content: ${gitInspectionFailure(issue)}`,
    EmbeddedRepository: ({ path }) =>
      `Embedded Git repository is not valid Artifact content: ${path}`,
    Submodule: ({ path }) => `Registered Git submodule is not valid Artifact content: ${path}`,
    IgnoredRoot: () => "The SKIT root is ignored by the enclosing Git repository",
    FullyExcludedRoot: () => "Git excludes every file in the SKIT root",
    EscapedPath: ({ path }) => `Path escaped tree: ${path}`,
    InvalidSymlink: ({ path }) => `Symlinks are not valid SKIT content: ${path}`,
    UnsupportedEntry: ({ path }) => `Unsupported filesystem entry: ${path}`,
    ChangedDuringRead: ({ path }) => `Filesystem entry changed while reading: ${path}`,
    NormalizedPathCollision: ({ path, firstPath, secondPath }) =>
      `Paths ${escapedUnicodePath(firstPath)} and ${escapedUnicodePath(secondPath)} both normalize to ${path}`,
    NativeIdentityMissing: ({ path }) => `Cannot record the filesystem identity of ${path}`,
    RootNotDirectory: ({ path, entryType }) =>
      `Tree root must be a directory; found ${entryTypes[entryType]}: ${path}`,
    CannotRetain: ({ entryType, path }) => `Cannot back up ${entryTypes[entryType]}: ${path}`,
  }),
);

export const treeFailureNext = Match.type<TreeErrorReason>().pipe(
  Match.tag("NormalizedPathCollision", () => ["Rename one of the conflicting paths, then retry."]),
  Match.tag("NativeIdentityMissing", () => [
    "Check that the source is on a filesystem that reports file identities before retrying.",
  ]),
  Match.tag("RootNotDirectory", () => [
    "Choose a directory as the source. For a symbolic link, use the directory it points to.",
  ]),
  Match.orElse(() => ["Remove or replace the reported entry in the SKIT, then retry."]),
);
