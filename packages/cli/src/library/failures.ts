import { describeFailure } from "../terminal/failure.js";
import { collectionVersionArchiveFailure } from "./collection-version-archive-failure.js";
import { schemaFailure, schemaFailureMessages } from "../platform/schema-failure.js";
import { Block } from "../terminal/blocks.js";
import {
  ImportContentInvalid,
  ImportContentInvalidReason,
  AddNoSkills,
  SetupImportInvalid,
  LibrarySubjectNotFound,
  LibrarySubjectAmbiguous,
  SharedMappingInvalid,
  CollectionRemovalMissing,
  SkillRemovalRequiresCollection,
  AcceptanceIncomplete,
  ContentAddressCollision,
  LibraryChanged,
  SecurityFindingAbsent,
  UnknownInstalledSkill,
  InvalidIntent,
  InvalidLibraryState,
  InvalidLibraryStateReason,
  ManageSelectionInvalid,
  SetEnabledInvalid,
  SetupStepsInvalid,
} from "@smolai/skit-core/library";
import { SyncConflicted, SyncLocalChanged } from "@smolai/skit-core/library/sync";
import { Match, Schema } from "effect";
import { renderSyncConflicts } from "./sync/conflict.js";
import { manageSelectionInvalid, setupStepsInvalid } from "./setup/failures.js";
import { setEnabledInvalid } from "./enable/failures.js";
import { treeFailure } from "../platform/tree-failure.js";
import type {
  InvocationUnavailable,
  AuthorInvocationFailure,
} from "@smolai/skit-core/library/session";
import type { FailureDescription } from "../terminal/failure.js";

/** Failures that carry data and no words: the Library says what happened, and this executable how. */
export const LibraryDataFailure = Schema.Union([
  SyncLocalChanged,
  ImportContentInvalid,
  AddNoSkills,
  SetupImportInvalid,
  LibrarySubjectNotFound,
  LibrarySubjectAmbiguous,
  SharedMappingInvalid,
  CollectionRemovalMissing,
  SkillRemovalRequiresCollection,
  AcceptanceIncomplete,
  ContentAddressCollision,
  LibraryChanged,
  SecurityFindingAbsent,
  UnknownInstalledSkill,
  InvalidIntent,
  InvalidLibraryState,
  ManageSelectionInvalid,
  SetEnabledInvalid,
  SetupStepsInvalid,
  SyncConflicted,
]);

const libraryFailureMessage = Match.type<typeof LibraryDataFailure.Type>().pipe(
  Match.tagsExhaustive({
    "Library.SyncLocalChanged": () => "The local Library changed while sync was running",
    ImportContentInvalid: ({ reason }) =>
      `SKIT validation failed: ${ImportContentInvalidReason.match(reason, {
        SelectedSkillsMissing: () => "Skills are missing from the Library",
        BackingMissing: ({ skillName }) =>
          `Skill ${skillName} has no selected source in the Library`,
        ContentChanged: ({ kind, skillName }) =>
          kind === "collection"
            ? `Stored copy for ${skillName} changed`
            : `Stored Skill ${skillName} changed`,
        DescriptorSkillMissing: ({ skillName }) => `Stored descriptor lacks Skill ${skillName}`,
      })}`,

    "Library.AddNoSkills": ({ source }) => `No Skills found in ${source}`,
    SetupImportInvalid: ({ skillName, reason }) =>
      `Cannot import ${skillName} during setup: ${
        {
          "duplicate-selection": "the same Skill copy was selected more than once",
          "candidate-not-found":
            "the selected Skill copy is absent from the current import choices",
          "observation-missing": "the scan has no complete Skill and lock-file evidence for it",
          "contested-observation": "its lock-file entries name different sources",
          "source-unresolvable": "its lock-file entries do not identify one importable source",
          "lock-changed": "the lock file no longer matches the scanned copy",
        }[reason]
      }`,
    "Library.SubjectNotFound": ({ query }) =>
      `No Skill or Collection in the Library matches ${query}`,
    "Library.SubjectAmbiguous": ({ query }) =>
      `More than one Skill or Collection in the Library matches ${query}`,
    "Library.SkillMaterializationInvalid": ({ target }) =>
      `Shared mapping target escaped Skill: ${target}`,
    "Library.CollectionRemovalMissing": ({ collection_id }) =>
      `Collection is no longer in the Library: ${collection_id}`,
    "Library.SkillRemovalRequiresCollection": ({ skill_id, collection_id }) =>
      `${skill_id} can be removed only with its Collection ${collection_id}`,
    AcceptanceIncomplete: ({ reason }) =>
      ({
        missing: "Principal and rationale are required",
        "invalid-expiry": "expires-at must be a valid ISO instant",
        "expiry-in-past": "expires-at must be later than acceptance time",
      })[reason],
    ContentAddressCollision: () => "Canonical library content-address collision",
    LibraryChanged: ({ path }) =>
      `The Library changed while this command ran; run it again: ${path}`,
    SecurityFindingAbsent: ({ fingerprint }) =>
      `Finding is not present in the Skill Version: ${fingerprint}`,
    UnknownInstalledSkill: ({ query }) => `Unknown installed skill: ${query}`,

    "Library.InvalidIntent": ({ intent }) =>
      ({
        AcceptFinding: "Invalid acceptance intent",
        RefreshInventory: "Invalid inventory intent",
        Manage: "Invalid Manage intent",
        Sync: "Invalid Sync intent",
      })[intent],
    InvalidLibraryState: ({ path, reason }) =>
      `Invalid Library state at ${path}: ${InvalidLibraryStateReason.match(reason, {
        SchemaInvalid: ({ failure }) => schemaFailure(failure),
        ArchiveInvalid: ({ failure }) => collectionVersionArchiveFailure(failure).message,
        InvalidData: ({ issue, tree }) =>
          tree === undefined ? (issue ?? "it cannot be read") : treeFailure(tree),
        UnsupportedVersion: ({ version, oldest, current }) =>
          version === undefined
            ? "Library state has no schema version"
            : version > current
              ? `Library state schema v${version} was written by a newer SKIT; this CLI supports v${oldest}–v${current}`
              : version >= oldest
                ? `Library state schema v${version} has not been migrated to v${current}; run SKIT again to migrate it`
                : `unsupported Library state schema v${version}; this CLI supports v${oldest}–v${current}`,
        MissingRecord: ({ record, at }) =>
          ({
            "pending-operation": "Installed changes require their Pending operation",
            "sync-step": "Expected a recorded Sync step",
            "sync-program": "Sync step has no recorded program",
            "imported-collection": `Setup step ${at} imported no Collection`,
            "folder-evidence": `Missing reviewed folder evidence at ${at}`,
            "installed-row": `Missing recorded installed row at ${at}`,
            "library-state": "Importing an installed skill's changes requires a Library",
          })[record],
        ContentChanged: ({ entry }) =>
          entry === undefined ? "stored content changed" : `stored content changed: ${entry}`,
        ContentMissing: ({ entry }) => `stored content is missing: ${entry}`,
        InvalidSymlink: () => "recovery directory is redirected",
      })}`,
    "Library.ManageSelectionInvalid": manageSelectionInvalid,
    "Library.SetEnabledInvalid": ({ reason }) => setEnabledInvalid[reason],
    "Library.SetupStepsInvalid": setupStepsInvalid,
    "Library.SyncConflicted": () => "Library sync stopped",
  }),
);

const libraryFailureNext = Match.type<typeof LibraryDataFailure.Type>().pipe(
  Match.tagsExhaustive({
    "Library.SyncLocalChanged": () => ["Run ", { code: "skit sync" }, " again."],
    ImportContentInvalid: () => [
      "Correct the reported diagnostics in the source, then add it again.",
    ],
    "Library.AddNoSkills": () => ["Choose a source that contains a SKILL.md."],
    SetupImportInvalid: () => [
      "Run ",
      { code: "skit setup" },
      " again and review the current plan.",
    ],
    "Library.SubjectNotFound": () => [
      "Run ",
      { code: "skit list" },
      " to find a Skill or Collection in the Library.",
    ],
    "Library.SubjectAmbiguous": () => [
      "Run skit list to choose the source, or use its workspace path or full source locator.",
    ],
    "Library.SkillMaterializationInvalid": () => [
      "Correct the Skill's shared mappings in the source, then retry.",
    ],
    "Library.CollectionRemovalMissing": () => [
      "Run ",
      { code: "skit list" },
      " to see the Collections in the Library.",
    ],
    "Library.SkillRemovalRequiresCollection": ({ collection_id }) => [
      "Remove the whole Collection with ",
      { code: "skit remove " + collection_id },
      ", or disable just this Skill.",
    ],
    AcceptanceIncomplete: ({ reason }) =>
      reason === "missing"
        ? ["Pass --principal and --rationale, then retry."]
        : ["Pass --expires-at as a future ISO instant, such as 2030-01-01T00:00:00Z."],
    ContentAddressCollision: () => [
      "Run ",
      { code: "skit doctor" },
      " to inspect the Library before retrying.",
    ],
    LibraryChanged: () => ["Run the command again."],
    SecurityFindingAbsent: () => [
      "Run ",
      { code: "skit security review <skill>" },
      " to list the findings in the Skill Version.",
    ],
    UnknownInstalledSkill: () => ["Run ", { code: "skit list" }, " to find an installed Skill."],
    InvalidLibraryState: () => [
      "Back up the state file before recovery. To reset an alpha Library, move it aside and run ",
      { code: "skit setup" },
      "; keep installed Skill files.",
    ],
    "Library.InvalidIntent": () => ["Check the reported failure and retry."],
    "Library.ManageSelectionInvalid": () => ["Check the reported failure and retry."],
    "Library.SetupStepsInvalid": () => ["Check the reported failure and retry."],
    "Library.SetEnabledInvalid": () => [
      "Select Skills or Collections in the Library and preview again.",
    ],
    "Library.SyncConflicted": () => [
      "Resolve the listed conflicts, then run ",
      { code: "skit sync" },
      " again.",
    ],
  }),
);

export const libraryFailure = (error: typeof LibraryDataFailure.Type) =>
  error._tag === "InvalidLibraryState" && error.reason._tag === "SchemaInvalid"
    ? describeFailure({
        summary: ["Invalid Library state at ", { code: error.path }],
        details: [
          Block.List({
            items: schemaFailureMessages(error.reason.failure).map((message) => ({
              text: [message],
            })),
          }),
        ],
        next: [
          "Back up the state file before recovery. To reset an alpha Library, move it aside and run ",
          { code: "skit setup" },
          "; keep installed Skill files.",
        ],
      })
    : error._tag === "Library.SyncConflicted"
      ? describeFailure({
          summary: [libraryFailureMessage(error)],
          details: renderSyncConflicts(error.conflicts),
          next: libraryFailureNext(error),
        })
      : describeFailure({
          summary: [libraryFailureMessage(error)],
          next: libraryFailureNext(error),
        });

/** The unavailable preference keeps its exact source failure; its owner gives that failure words. */
export const invocationUnavailableFailure = (
  error: InvocationUnavailable,
  formatFailure: (failure: AuthorInvocationFailure) => FailureDescription,
) => {
  const cause = formatFailure(error.failure);
  return describeFailure({
    summary: ["SKIT validation failed"],
    details: [Block.Group({ title: "Validation failed", children: cause.explanation })],
    next: cause.next,
  });
};
