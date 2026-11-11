import { describeFailure } from "../../terminal/failure.js";
import type { FailureDescription } from "../../terminal/failure.js";
import { Block } from "../../terminal/blocks.js";
import type {
  RecoveryInvalid,
  RecoveryFactReason,
  UndoConflict,
  UndoScope,
} from "@smolai/skit-core/library";
import { Match } from "effect";
import { treeFailure } from "../../platform/tree-failure.js";

const undoScope = Match.type<UndoScope>().pipe(
  Match.tagsExhaustive({
    Account: () => "enabled everywhere",
    Device: () => "this device's enabled list",
    Repository: ({ root }) => `enabled in repository ${root}`,
  }),
);

export const undoConflict = Match.type<UndoConflict>().pipe(
  Match.tagsExhaustive({
    MachineChanged: () => "Setup belongs to a different machine identity",
    DiscoveryFoldersChanged: () => "Discovery folders changed after setup",
    UnsupportedOperation: ({ kind }) =>
      ({
        recovery: "Recovery Restore and Undo records cannot themselves be undone by setup undo.",
        apply:
          "Recorded Library changes support startup recovery; use the corresponding Library command to change them.",
        sync: "Sync records support startup recovery. Undo cannot reverse their remote publication; review what is enabled and sync again.",
        pending: "Setup has not finished. Run any SKIT command to finish or stop it, then undo it.",
      })[kind],
    SelectionChanged: ({ scope, key, kind }) =>
      `${undoScope(scope)} ${kind === "invocation" ? "invocation " : ""}${key}`,
    SelectionMissing: ({ scope, key }) => `${undoScope(scope)} cannot find ${key} in the Library`,
    DeviceModeChanged: () => "device selection mode",
    DeviceSelectionChanged: () => "device selection",
    SkillVersionChanged: ({ skillId }) => `selected Version ${skillId}`,
    SkillMissing: ({ skillId }) => `Skill missing from the Library: ${skillId}`,
    CollectionMembershipChanged: ({ collectionId }) =>
      `Collection source membership ${collectionId} requires restoration before undo`,
    SourceChanged: ({ collectionId }) => `Collection source changed after setup: ${collectionId}`,
    SourceEvidenceMissing: ({ collectionId }) =>
      `Prior Collection Version evidence is unavailable: ${collectionId}`,
    SourceBytesChanged: ({ collectionId }) =>
      `Prior Collection Version bytes changed: ${collectionId}`,
    ImportAlreadyRecorded: ({ collectionId }) =>
      `Undo import identity is already recorded: ${collectionId}`,
    ClockNotAdvanced: ({ collectionId }) =>
      `Clock has not advanced past the current Source record: ${collectionId}`,
    OwnershipUnconfirmed: ({ path }) => `Setup's ownership claim is not confirmed: ${path}`,
    PathProtected: ({ path }) =>
      `Repository, authored or package-manager ownership protects this path: ${path}`,
    ParentChanged: ({ path }) => `Original parent changed: ${path}`,
    StorageOverlap: ({ path }) => `Library storage cannot be restored over: ${path}`,
    OriginalPathsOverlap: ({ path }) => `Overlapping original paths: ${path}`,
    InstalledChoiceChanged: ({ path }) => `Installed-skill choice changed: ${path}`,
    OriginalEdited: ({ path }) => `Managed original was edited: ${path}`,
    DestinationOccupied: ({ path }) => `Occupied original path: ${path}`,
    CopyMissing: ({ path }) => `Installed copy disappeared without an undo backup: ${path}`,
    OriginalBytesMissing: ({ path }) => `Original bytes unavailable: ${path}`,
    DifferentDevice: ({ path }) => `Original cannot be renamed across devices: ${path}`,
  }),
);

export const recoveryFactReason = (reason: RecoveryFactReason): string =>
  ({
    "parent-changed": "Original parent is missing, replaced or redirected",
    saved: "Verified saved entry; original destination is free",
    "at-original": "Verified entry is at its original path",
    missing: "Neither original nor saved entry exists",
    "destination-occupied": "Original destination is occupied; keep both entries",
    "entry-changed": "Saved or original entry differs from its move record",
  })[reason];

export const recoveryInvalidFailure = (
  error: RecoveryInvalid,
  formatFailure: (error: unknown) => FailureDescription,
) => {
  if (error.reason._tag === "OperationStopped") {
    const { operation, reason } = error.reason;
    const summary = [`Recorded ${operation.toLowerCase()} stopped`];
    const next =
      "Review Library history and inspect the saved files and their move record; keep both before resolving the conflict.";
    if (reason._tag === "StepFailed") {
      const cause = formatFailure(reason.error);
      return describeFailure({
        summary,
        details: [
          Block.Group({ title: `Step ${reason.step + 1} failed`, children: cause.explanation }),
        ],
        next: [...cause.next, " ", next],
      });
    }
    return describeFailure({
      summary,
      details: Match.value(reason).pipe(
        Match.tagsExhaustive({
          EvidenceDiffers: ({ path }) => [
            Block.Note({ text: [{ code: path }, " changed after it was reviewed."] }),
          ],
          LibraryChanged: () => [Block.Note({ text: ["The Library changed while recovery ran."] })],
        }),
      ),
      next: [next],
    });
  }
  const detail = Match.value(error.reason).pipe(
    Match.tagsExhaustive({
      InvalidTree: ({ reason }) => treeFailure(reason),
      InvalidData: ({ record, path }) =>
        ({
          "operation-directory": "Invalid recovery operation directory",
          "operation-id": "Invalid operation identifier",
          "move-record": `Invalid move record: ${path}`,
          "move-entry": `Unsafe or incomplete entry in ${path}`,
          "restore-review": "Invalid Restore review",
          "setup-evidence": "Invalid recorded setup evidence",
          "setup-record": "Invalid setup record",
          "undo-plan": "Invalid undo plan",
        })[record],
      MissingRecord: ({ record, at }) =>
        ({
          "undo-record": `Setup ${at} has no undo record: a later setup replaced it`,
          "undo-files": "Missing reviewed Undo files",
          "file-evidence": "Missing Undo file evidence",
          "action-evidence": "Missing Undo action evidence",
          "ownership-evidence": "Missing ownership evidence",
          "source-evidence": "Missing original source evidence",
          "reconstruction-evidence": "Missing reconstruction evidence",
          "reconstruction-owner": "Missing reconstruction owner",
          "undo-file": "Missing Undo file",
          "original-marker": "Missing original marker",
          "marker-metadata": `Original marker metadata unavailable at ${at}`,
          successor: `Missing successor: ${at}`,
        })[record],
      UnsafePath: ({ kind, path }) =>
        ({
          "operation-directory": "Operation must belong to this Library's recovery directory",
          "overlapping-entries": "Overlapping recovery entries are unsafe",
          "library-storage": "Library storage cannot be displaced",
          "recovery-storage": "Recovery cannot displace its own storage",
          "recovery-directory": `Expected a recovery directory at ${path}`,
          "move-record": `Move record is not a regular file: ${path}`,
          archive: `Unsafe archive path in ${path}`,
          "original-parent": `Redirected original parent: ${path}`,
          "original-parent-missing": `Redirected or missing original parent: ${path}`,
          parent: `Unsafe parent for ${path}`,
          "ownership-marker": `Unsafe ownership marker at ${path}`,
          "undo-staging": `Redirected Undo staging: ${path}`,
          "missing-parent": `No parent for ${path}`,
        })[kind],
      ContentChanged: ({ kind, path }) =>
        ({
          "undo-source": `Undo source changed: ${path}`,
          "recovery-copy": `Undo recovery copy changed: ${path}`,
          "reconstruction-source": "Undo reconstruction source changed",
          reconstruction: `Reconstruction differs from original: ${path}`,
          restoration: `Original restoration incomplete: ${path}`,
        })[kind],
      Conflicts: ({ conflicts }) => conflicts.map(undoConflict).join("; "),
    }),
  );
  return describeFailure({
    summary: [`Recovery cannot proceed: ${detail}`],
    next: [
      "Inspect the saved files and their move record; keep both before resolving the conflict.",
    ],
  });
};
