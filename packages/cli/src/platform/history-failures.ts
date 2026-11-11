import { describeFailure } from "../terminal/failure.js";
import * as History from "@smolai/skit-core/history";
import { Match } from "effect";
import { errorMessage } from "@smolai/skit-core/shared";
import { schemaFailure } from "./schema-failure.js";

export const treePathIssue = (issue: History.TreePathIssue): string =>
  History.TreePathIssue.match(issue, {
    DuplicatePath: ({ path }) => `Duplicate tree path: ${path}`,
    ParentNotDirectory: ({ path, parent, kind }) =>
      `${path}: a ${kind} at ${parent} cannot contain descendants`,
  });

export const historyStoreFailure = Match.type<History.StoreError>().pipe(
  Match.tagsExhaustive({
    "History.StoreMissing": ({ kind, hash }) =>
      describeFailure({
        summary: [`Stored ${kind} ${hash} is missing`],
        next: ["Keep the history files and restore the missing content before syncing again."],
      }),
    "History.StoreCorrupt": ({ kind, hash, reason }) =>
      describeFailure({
        summary: [
          `Stored ${kind} ${hash} is invalid: ${History.StoreCorruptReason.match(reason, {
            InvalidData: ({ failure }) => schemaFailure(failure),
            ContentHashMismatch: ({ actual }) => `content has hash ${actual}`,
            BlobMissing: ({ blob }) => `file blob ${blob} is missing`,
            BlobHashMismatch: ({ blob, actual }) => `file blob ${blob} has content hash ${actual}`,
          })}`,
        ],
        next: ["Keep the history files and restore the invalid content before syncing again."],
      }),
    "History.StoreFailed": ({ cause }) =>
      describeFailure({
        summary: [`History storage failed: ${errorMessage(cause)}`],
        next: ["Keep the history files and resolve the storage problem before syncing again."],
      }),
  }),
);
