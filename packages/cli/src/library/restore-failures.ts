import { describeFailure } from "../terminal/failure.js";
import {
  RestoreInvalid,
  RestoreInvalidReason,
  RestoreOwnershipConflict,
} from "@smolai/skit-core/library/restore/failures";
import { schemaFailure } from "../platform/schema-failure.js";

const restoreOwnershipConflict = (conflict: RestoreOwnershipConflict): string =>
  RestoreOwnershipConflict.match(conflict, {
    InstalledVersionMissing: ({ path, versionId }) =>
      `installed Skill at ${path} uses Version ${versionId}, which is absent from the restored Library`,
    RepositorySelectionMissing: ({ root, selection }) =>
      `repository ${root} selects missing ${"skill" in selection ? `Skill ${selection.skill}` : `Collection ${selection.collection}`}`,
  });

const restoreReason = (reason: RestoreInvalidReason): string =>
  RestoreInvalidReason.match(reason, {
    CopiesUnavailable: ({ ids }) => `Collection Versions unavailable: ${ids.join(", ")}`,
    SyncContentChanged: ({ hash }) => `stored sync content changed: ${hash}`,
    ForeignCopy: ({ hash }) => `plan references foreign Collection Version ${hash}`,
    DownloadForSourceCopy: ({ hash }) =>
      `plan requests a private download for source-backed Collection Version ${hash}`,
    UnknownCopy: ({ id }) => `unknown Collection Version ${id}`,
    SourceRestoreUnavailable: ({ hash }) =>
      `Collection Version ${hash} requires stored bytes and cannot be restored from its Source`,
    CopyNotAvailable: ({ hash }) => `Collection Version ${hash} is unavailable`,
    DownloadTransportMissing: ({ hashes }) =>
      `no transport to download required Collection Versions: ${hashes.join(", ")}`,
    ReusableCopyMissing: ({ hash, path }) =>
      `Collection Version ${hash} disappeared after planning: ${path}`,
    DownloadHashMismatch: ({ expected, actual }) =>
      `download returned ${actual}; expected ${expected}`,
    MemberHashMismatch: ({ path, expected, actual }) =>
      `Collection Version member ${path} source bytes disagree: expected ${expected}, found ${actual}`,
    StateInvalid: ({ stage, failure }) =>
      `${
        {
          "target-manifest": "invalid target manifest",
          "restored-library": "restored state failed Library validation",
          "merged-library": "merged Library conflicts with what this device enables or owns",
        }[stage]
      }: ${schemaFailure(failure)}`,
    OwnershipWouldBeStranded: ({ conflicts }) => conflicts.map(restoreOwnershipConflict).join("; "),
  });

export const restoreFailure = ({ reason }: RestoreInvalid) =>
  describeFailure({
    summary: [`Cannot restore the Library: ${restoreReason(reason)}`],
    next:
      reason._tag === "OwnershipWouldBeStranded"
        ? [
            "Keep the installed Skill files and run ",
            { code: "skit doctor" },
            " to inspect the missing references before retrying the restore.",
          ]
        : [
            "Run ",
            { code: "skit doctor" },
            " to inspect the Library, then run ",
            { code: "skit sync" },
            " again.",
          ],
  });
