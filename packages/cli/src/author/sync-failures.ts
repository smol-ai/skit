import { describeFailure } from "../terminal/failure.js";
import { SyncFailure } from "@smolai/skit-core/sync/failures";
import { Match } from "effect";
import { treePathIssue } from "../platform/history-failures.js";

export const syncFailure = Match.type<SyncFailure>().pipe(
  Match.tagsExhaustive({
    "Sync.RemoteInvalid": ({ id, reason }) =>
      describeFailure({
        summary: [
          `The Registry sent revision ${id} in a form that does not match it: ${Match.valueTags(
            reason,
            {
              TreeMismatch: ({ actual, expected }) =>
                `its tree has hash ${actual}, expected ${expected}`,
              RevisionMismatch: ({ actual }) => `its revision identity is ${actual}`,
              EditTimesMismatch: ({ paths }) =>
                `edit times do not match tree paths: ${paths.join(", ")}`,
            },
          )}`,
        ],
        next: [
          "Run ",
          { code: "skit author sync" },
          " again; if it keeps failing, report the Registry's response.",
        ],
      }),
    "Sync.InvalidTree": ({ issue }) =>
      describeFailure({
        summary: [treePathIssue(issue)],
        next: ["Keep the local files and history; report this invalid sync tree."],
      }),
    "Sync.Unsettled": ({ steps }) =>
      describeFailure({
        summary: [
          `Sync did not settle after ${steps} steps while other devices kept changing the SKIT`,
        ],
        next: ["Run ", { code: "skit author sync" }, " again."],
      }),
  }),
);
