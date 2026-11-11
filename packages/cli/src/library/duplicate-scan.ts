import { describeFailure } from "../terminal/failure.js";
import { DuplicateScanIssue } from "@smolai/skit-core/library/routing";

/** Native scan errors remain facts until this frontend presents the inaccessible directory. */
export const duplicateScanIssue = (reason: DuplicateScanIssue): string =>
  DuplicateScanIssue.match(reason, {
    EntryLimitExceeded: ({ limit }) => `Skills directory exceeds the ${limit}-entry scan limit`,
    Unreadable: ({ error }) => String(error),
  });

export const duplicateScanFailure = (
  error: import("@smolai/skit-core/library/routing").DuplicateScanIncomplete,
) =>
  describeFailure({
    summary: [`${duplicateScanIssue(error.reason)}: ${error.path}`],
    next: ["Inspect the skills directory before enabling another copy."],
  });
