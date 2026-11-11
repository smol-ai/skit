import { describeFailure } from "../terminal/failure.js";
import { PnpmSkillManaged } from "@smolai/skit-core/installed-skills/pnpm-failures";
import {
  InstalledSkillsChanged,
  InstalledSkillFailure,
  InstalledSkillFailureReason,
  InstalledSkillInvalid,
  InstalledSkillInvalidReason,
  UninstallConflict,
  UnsafeInstalledSkillName,
  UnsafeInstalledSkillBackups,
  SharedTargetCollision,
  InstalledPathCollision,
  SkillsDirectoryNotWritable,
  OwnershipMarkerDisagrees,
  InstalledSkillFileMissing,
} from "@smolai/skit-core/library";
import { Match, Schema } from "effect";
import { treeFailure } from "../platform/tree-failure.js";

const installedSkillFailureReason = (reason: InstalledSkillFailureReason): string =>
  InstalledSkillFailureReason.match(reason, {
    InvalidTree: ({ reason }) => treeFailure(reason),
    SharedPathOutsideSkill: ({ path }) => `Shared mapping target escaped child: ${path}`,
    DestinationAppeared: ({ path }) => `Installed skill appeared before installing: ${path}`,
    IdentityChanged: ({ path }) =>
      `Installed skill identity or marker changed during commit: ${path}`,
    HashChanged: ({ verification, skillId, path }) =>
      `Post-${verification} hash verification failed for ${skillId} at ${path}`,
    EvidenceChanged: ({ path }) => `Installed skill evidence changed before commit: ${path}`,
    VersionMissing: ({ kind }) =>
      kind === "former"
        ? "Former installed skill has no stored Skill Version"
        : "An enabled Skill has no selected stored Version",
    BackingMissing: ({ skillName }) => `Skill ${skillName} in the Library has no backing`,
    DescriptorInvalid: () => "The authored descriptor in the Library is invalid",
    DescriptorSkillMissing: ({ skillName }) => `authored descriptor lacks ${skillName}`,
    ContentChanged: ({ skillName }) => `Skill ${skillName} in the Library changed`,
    InputsChanged: ({ skillName }) => `Skill ${skillName} inputs in the Library changed`,
  });

export const installedSkillInvalidReason = Match.type<InstalledSkillInvalidReason>().pipe(
  Match.tags({
    DestinationsUnknown: () => "This device's install destinations are unknown",
    NotSkillFolder: ({ path }) => `Not a skill folder: ${path}`,
    ManageTargetChanged: ({ path }) => `The folder to manage changed after preview: ${path}`,
    ManageContentMismatch: ({ path }) =>
      `The folder to manage does not match the Skill Version in the Library: ${path}`,
    ApplyStopped: () => "Library apply stopped before its outcome could be recorded",
    BackupNotReviewed: () => "Only a reviewed conflict can be backed up",
  }),
  Match.orElse(installedSkillFailureReason),
);

export const InstalledSkillsDataFailure = Schema.Union([
  PnpmSkillManaged,
  InstalledSkillsChanged,
  InstalledSkillFailure,
  InstalledSkillInvalid,
  UninstallConflict,
  UnsafeInstalledSkillName,
  UnsafeInstalledSkillBackups,
  SharedTargetCollision,
  InstalledPathCollision,
  SkillsDirectoryNotWritable,
  OwnershipMarkerDisagrees,
  InstalledSkillFileMissing,
]);

export const installedSkillsFailure = Match.type<typeof InstalledSkillsDataFailure.Type>().pipe(
  Match.tagsExhaustive({
    PnpmSkillManaged: ({ path, package: name }) =>
      describeFailure({
        summary: [`${path} is managed by pnpm (${name}); SKIT leaves it in place.`],
        next: ["Manage this Skill through pnpm's dependency and permission settings."],
      }),
    "Library.InstalledSkillsChanged": ({ path }) =>
      describeFailure({
        summary: [`Installed skill evidence changed at ${path}`],
        next: ["Preview the change again."],
      }),
    InstalledSkillFailure: ({ reason }) =>
      describeFailure({
        summary: [installedSkillFailureReason(reason)],
        next: ["Run ", { code: "skit doctor" }, " to inspect the installed skill, then retry."],
      }),
    "Library.InstalledSkillInvalid": ({ reason }) =>
      describeFailure({
        summary: [installedSkillInvalidReason(reason)],
        next: ["Run ", { code: "skit doctor" }, " to inspect the Library, then retry."],
      }),
    UninstallConflict: ({ path }) =>
      describeFailure({
        summary: [`Refusing to remove modified Skill at ${path}`],
        next: [
          "Run ",
          { code: "skit doctor" },
          " to inspect the changed installed skill before retrying.",
        ],
      }),
    UnsafeInstalledSkillName: (error) =>
      describeFailure({
        summary: [`Unsafe installed-skill name: ${error.skillName}`],
        next: ["Rename the Skill to a single safe path segment, then retry."],
      }),
    UnsafeInstalledSkillBackups: (error) =>
      describeFailure({
        summary: [
          `Installed-skill backups need a real directory whose .gitignore ignores everything: ${error.path}`,
        ],
        next: [
          "Replace the link or special file with a real directory, or make its .gitignore contain only ",
          { code: "*" },
          ", keeping any existing backups, then retry.",
        ],
      }),
    SharedTargetCollision: (error) =>
      describeFailure({
        summary: [`Shared target collision: ${error.target}`],
        next: [
          "Two enabled lists use one destination; choose a single Scope or route, then retry.",
        ],
      }),
    ProjectedPathCollision: (error) =>
      describeFailure({
        summary: [
          error.kind === "file"
            ? `Installed file collision: ${error.path}`
            : `Installed file/directory collision: ${error.path}`,
        ],
        next: ["Two Skills install to the same path; disable one of them, then retry."],
      }),
    SkillsDirectoryNotWritable: (error) =>
      describeFailure({
        summary: [`SKIT cannot write to ${error.root}: permission denied`],
        next: [
          "If an agent sandbox is running SKIT, re-run this command with write access to " +
            error.root +
            " (for example, approve running it outside the sandbox). Otherwise check that directory's permissions.",
        ],
      }),
    OwnershipMarkerDisagrees: (error) =>
      describeFailure({
        summary: [
          `Installed-skill state and ownership marker disagree for ${error.skillId} at ${error.target}`,
        ],
        next: ["Run ", { code: "skit doctor" }, " to inspect the installed skill before retrying."],
      }),
    InstalledSkillFileMissing: (error) =>
      describeFailure({
        summary: [`Installed skill is missing ${error.path}`],
        next: ["Run ", { code: "skit doctor" }, " to inspect the installed skill, then retry."],
      }),
  }),
);
