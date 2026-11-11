import { gitInspectionFailure } from "./git-inspection-failure";
import { artifactFailure } from "./artifact-failures";
import type { AuthorInvocationFailure } from "@smolai/skit-core/library/session";
import { ImportContentInvalidReason } from "@smolai/skit-core/library";
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

export const treeFailure = Match.type<TreeErrorReason>().pipe(
  Match.tagsExhaustive({
    GitCommandFailed: ({ command, exitCode }) => `${command} exited with ${exitCode}`,
    GitInspectionFailed: ({ issue }) =>
      `Unable to inspect Git ignore rules: ${gitInspectionFailure(issue)}`,
    EmbeddedRepository: ({ path }) => `Embedded Git repository: ${path}`,
    Submodule: ({ path }) => `Registered Git submodule: ${path}`,
    IgnoredRoot: () => "The SKIT root is ignored by Git",
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

/** Invocation reads remain structured until the TUI presents the unavailable preference. */
export const invocationFailure = Match.type<AuthorInvocationFailure>().pipe(
  Match.tagsExhaustive({
    ImportContentInvalid: ({ reason }) =>
      ImportContentInvalidReason.match(reason, {
        SelectedSkillsMissing: () => "Skills are missing from the Library",
        BackingMissing: ({ skillName }) =>
          `Skill ${skillName} has no selected source in the Library`,
        ContentChanged: ({ kind, skillName }) =>
          kind === "collection"
            ? `Stored copy for ${skillName} changed`
            : `Stored Skill ${skillName} changed`,
        DescriptorSkillMissing: ({ skillName }) => `Stored descriptor lacks Skill ${skillName}`,
      }),
    HarnessMetadataInvalid: artifactFailure,
    DescriptorMalformed: artifactFailure,
    DuplicateSkillNames: artifactFailure,
    DuplicateSkillPaths: artifactFailure,
    ConflictingInvocationDeclaration: artifactFailure,
    ReadmeFrontmatterMissing: artifactFailure,
    TreeError: ({ reason }) => treeFailure(reason),
    PlatformError: (error) => error.message,
  }),
);
