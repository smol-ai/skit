import { describeFailure } from "../terminal/failure.js";
import { ApplyFailure } from "@smolai/skit-core/library/enable";
import { Match } from "effect";
import { errorMessage } from "@smolai/skit-core/shared";
import { libraryFailure } from "./failures.js";
import { installedSkillsFailure } from "./installed-skill-failures.js";
import { planFailure } from "./plan-failures.js";
import { artifactFailure } from "../platform/artifact-failures.js";
import { platformFailure } from "../platform/failures.js";
import { treeFailure, treeFailureNext } from "../platform/tree-failure.js";
import { duplicateScanFailure } from "./duplicate-scan.js";

/** Applying a Library plan must have words for every checked error in its core union. */
export const applyFailure = Match.type<ApplyFailure>().pipe(
  Match.tagsExhaustive({
    PlatformError: (error) =>
      describeFailure({
        summary: [errorMessage(error)],
        next: ["Check the reported failure and retry."],
      }),
    InvalidLibraryState: libraryFailure,
    "Library.InvalidIntent": libraryFailure,
    "Library.SetEnabledInvalid": libraryFailure,
    "Library.StalePlan": planFailure,
    "Library.CollectionRemovalMissing": libraryFailure,
    "Library.InstalledSkillInvalid": installedSkillsFailure,
    InstalledSkillFailure: installedSkillsFailure,
    SkillsDirectoryNotWritable: installedSkillsFailure,
    UnsafeInstalledSkillName: installedSkillsFailure,
    OwnershipMarkerDisagrees: installedSkillsFailure,
    UninstallConflict: installedSkillsFailure,
    UnsafeInstalledSkillBackups: installedSkillsFailure,
    HarnessMetadataInvalid: artifactFailure,
    InstalledSkillFileMissing: installedSkillsFailure,
    TreeError: ({ reason }) =>
      describeFailure({
        summary: [treeFailure(reason)],
        next: treeFailureNext(reason),
      }),
    DuplicateScanIncomplete: duplicateScanFailure,
    DescriptorMalformed: artifactFailure,
    DuplicateSkillNames: artifactFailure,
    DuplicateSkillPaths: artifactFailure,
    ConflictingInvocationDeclaration: artifactFailure,
    ReadmeFrontmatterMissing: artifactFailure,
    "Library.DestinationsIncomplete": planFailure,
    InstalledSkillWouldDuplicate: planFailure,
    InstalledSkillWouldReplaceLink: planFailure,
    SharedTargetCollision: installedSkillsFailure,
    ProjectedPathCollision: installedSkillsFailure,
    HomeBusy: platformFailure,
    LibraryChanged: libraryFailure,
  }),
);
