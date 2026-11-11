import * as History from "@smolai/skit-core/history";
import { Match } from "effect";
import { errorMessage } from "@smolai/skit-core/shared";
import { schemaFailure } from "./schema-failure";

export const treePathIssue = (issue: History.TreePathIssue): string =>
  History.TreePathIssue.match(issue, {
    DuplicatePath: ({ path }) => `Duplicate tree path: ${path}`,
    ParentNotDirectory: ({ path, parent, kind }) =>
      `${path}: a ${kind} at ${parent} cannot contain descendants`,
  });

export const historyStoreFailure = Match.type<History.StoreError>().pipe(
  Match.tagsExhaustive({
    "History.StoreMissing": ({ kind, hash }) => ({
      message: `Stored ${kind} ${hash} is missing`,
      remediation: "Keep the history files and restore the missing content before syncing again.",
    }),
    "History.StoreCorrupt": ({ kind, hash, reason }) => ({
      message: `Stored ${kind} ${hash} is invalid: ${History.StoreCorruptReason.match(reason, {
        InvalidData: ({ failure }) => schemaFailure(failure),
        ContentHashMismatch: ({ actual }) => `content has hash ${actual}`,
        BlobMissing: ({ blob }) => `file blob ${blob} is missing`,
        BlobHashMismatch: ({ blob, actual }) => `file blob ${blob} has content hash ${actual}`,
      })}`,
      remediation: "Keep the history files and restore the invalid content before syncing again.",
    }),
    "History.StoreFailed": ({ cause }) => ({
      message: `History storage failed: ${errorMessage(cause)}`,
      remediation: "Keep the history files and resolve the storage problem before syncing again.",
    }),
  }),
);
