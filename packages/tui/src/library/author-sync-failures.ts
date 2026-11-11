import { SyncFailure } from "@smolai/skit-core/sync/failures";
import { Match } from "effect";
import { treePathIssue } from "./history-store-failures";

export const syncFailure = Match.type<SyncFailure>().pipe(
  Match.tagsExhaustive({
    "Sync.RemoteInvalid": ({ id, reason }) => ({
      message: `The Registry sent revision ${id} in a form that does not match it: ${reason._tag === "TreeMismatch" ? `its tree has hash ${reason.actual}, expected ${reason.expected}` : `its revision identity is ${reason.actual}`}`,
      remediation: "Sync again; if it keeps failing, report the Registry's response.",
    }),
    "Sync.InvalidTree": ({ issue }) => ({
      message: treePathIssue(issue),
      remediation: "Keep the local files and history; report this invalid sync tree.",
    }),
    "Sync.Unsettled": ({ steps }) => ({
      message: `Sync did not settle after ${steps} steps while other devices kept changing the SKIT`,
      remediation: "Sync again.",
    }),
  }),
);
