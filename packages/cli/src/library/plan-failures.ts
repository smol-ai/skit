import { describeFailure } from "../terminal/failure.js";
import {
  ManageStopped,
  SyncStopped,
  StalePlan,
  StalePlanReason,
  InstalledSkillWouldReplaceLink,
  InstalledSkillWouldDuplicate,
  DestinationsIncomplete,
} from "@smolai/skit-core/library";
import { Match, Schema } from "effect";

export const PlanDataFailure = Schema.Union([
  ManageStopped,
  SyncStopped,
  StalePlan,
  InstalledSkillWouldReplaceLink,
  InstalledSkillWouldDuplicate,
  DestinationsIncomplete,
]);

const stalePlanReason = (reason: StalePlanReason): string =>
  StalePlanReason.match(reason, {
    SnapshotRequired: () => "Planning requires the displayed Library snapshot",
    SnapshotChanged: () => "The displayed Library snapshot changed",
    LibraryChanged: () => "The Library changed since this was previewed",
    ReviewedStateChanged: () => "The reviewed state changed since this was previewed",
    PlanChanged: ({ kind }) =>
      kind === "apply"
        ? "The Library differs from the reviewed plan"
        : "Install Destinations or paths changed after preview",
    PlanInvalid: ({ kind }) =>
      ({
        intent: "The plan tag does not match its reviewed intent",
        acceptance: "Invalid acceptance plan",
        manage: "Invalid Manage plan",
      })[kind],
    OperationMissing: ({ kind }) =>
      ({
        undo: "Undo requires its Pending operation",
        install: "Installed changes require their Pending operation",
        "sync-publication": "Sync state requires its recorded publication step",
      })[kind],
    OperationAlreadyRecorded: () => "This operation is already recorded",
    EvidenceChanged: ({ kind, path }) =>
      ({
        undo:
          path === undefined
            ? "Undo evidence changed after it was reviewed"
            : `Undo evidence changed at ${path}`,
        "undo-staging":
          path === undefined ? "Undo staging changed" : `Undo staging changed: ${path}`,
        "undo-successor":
          path === undefined ? "Undo successor changed" : `Undo successor changed: ${path}`,
        recovery:
          path === undefined
            ? "Recovery evidence changed since this was reviewed"
            : `Recovery evidence changed at ${path}`,
        "recovery-entry":
          path === undefined ? "Restored entry differs" : `Restored entry differs at ${path}`,
        manage:
          path === undefined
            ? "Reviewed Manage folders changed"
            : `Reviewed Manage folder changed at ${path}`,
        installed:
          path === undefined
            ? "Installed skill evidence changed"
            : `Installed skill evidence changed at ${path}`,
        "inventory-backup": "An inventory backup changed before it could be kept",
      })[kind],
    ContentChanged: ({ kind, path, skillName }) =>
      ({
        skill: "Reviewed Skill content changed",
        edit: "The installed skill's bytes changed after the edit import was previewed",
        reviewed:
          skillName === undefined
            ? "Reviewed content changed"
            : `Reviewed content changed for ${skillName}`,
        "undo-source": path === undefined ? "Undo source changed" : `Undo source changed: ${path}`,
      })[kind],
    MissingRecord: ({ record, at }) =>
      ({
        "undo-source": "Undo source is missing",
        "installed-row": at === undefined ? "Missing installed row" : `Missing installed row ${at}`,
        "installed-folder":
          at === undefined ? "Missing recorded folder" : `Missing recorded folder at ${at}`,
        "selected-version": "Selected Version in the Library is incomplete",
        "edited-copy": "The reviewed installed Skill is no longer recorded",
      })[record],
    DestinationOccupied: ({ kind, path }) =>
      kind === "undo-source"
        ? `Restored Undo source is occupied: ${path}`
        : `Undo destination occupied: ${path}`,
    SessionNotOpen: ({ action }) =>
      action === "propose"
        ? "Open the Library before proposing a change"
        : "Open the Library before confirming a change",
    SyncChanged: ({ part }) =>
      ({
        manifest: "The staged Sync manifest changed",
        base: "The accepted Sync base changed",
        target: "Staged Sync content differs from the reviewed target",
      })[part],
    SyncPlanInvalid: ({ reason }) =>
      ({
        "library-mismatch": "The Sync plan belongs to another Library",
        "receipt-missing": "This Sync plan requires its remote receipt",
        "receipt-mismatch": "The remote receipt does not match the reviewed Sync plan",
        "unexpected-receipt": "This local Sync plan cannot accept a remote receipt",
      })[reason],
    InstalledBytesChanged: ({ kind, path }) =>
      ({
        reviewed: `Reviewed installed bytes changed at ${path}`,
        recorded: `Recorded installed bytes changed at ${path}`,
        installed: `Installed bytes differ at ${path}`,
      })[kind],
  });

export const planFailure = Match.type<typeof PlanDataFailure.Type>().pipe(
  Match.tagsExhaustive({
    "Library.ManageStopped": ({ operationId }) =>
      describeFailure({
        summary: [
          `Manage stopped after recording operation ${operationId}. No changes were rolled back.`,
        ],
        next: [
          "Inspect Library history and preview undoing operation " +
            operationId +
            ", or review a new setup.",
        ],
      }),
    "Library.SyncStopped": ({ operationId }) =>
      describeFailure({
        summary: [`Local Sync stopped at its recorded operation ${operationId}`],
        next: ["Inspect Library history and retry Sync after resolving the reported change."],
      }),
    "Library.StalePlan": ({ reason }) =>
      describeFailure({ summary: [stalePlanReason(reason)], next: ["Preview the change again."] }),
    InstalledSkillWouldReplaceLink: (error) =>
      describeFailure({
        summary: [
          `Enabling would replace the link at ${error.links.join(", ")} with SKIT's copy, so both cannot be kept`,
        ],
        next: [
          "Remove the link and enable again, or run ",
          { code: "skit setup" },
          " and choose to back it up with a move record.",
        ],
      }),
    InstalledSkillWouldDuplicate: (error) =>
      describeFailure({
        summary: [
          `Enabling would create duplicate skills: ${error.duplicates.flatMap((item) => item.aliases.map((alias) => `${item.name} (${item.harness}): ${alias.path}${alias.via === "symlink" ? ` -> ${item.canonicalPath} (symlink${alias.linkPath !== alias.path ? ` at ${alias.linkPath} -> ${alias.linkTarget}` : ""})` : ""}`)).join("; ")}`,
        ],
        next: [
          "Remove the redundant agent location, keep the Skill in the Library without enabling it, or explicitly use --allow-duplicate.",
        ],
      }),
    "Library.DestinationsIncomplete": (error) =>
      describeFailure({
        summary: [`Selected destinations are incomplete: ${error.paths.join(", ")}`],
        next: [
          "Inspect these destinations and keep unmanaged or modified content before retrying.",
        ],
      }),
  }),
);
