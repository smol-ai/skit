import { SkitContractError } from "@smolai/skit-core/api";
import { Match } from "effect";
import { schemaFailure } from "./schema-failure";
import { treePathIssue } from "./history-store-failures";
import { errorMessage } from "@smolai/skit-core/shared";

export const apiContractFailure = ({ contract, reason }: SkitContractError) => {
  if (reason._tag === "ReadFailed")
    return {
      message: `Unable to read ${contract}: ${errorMessage(reason.failure)}`,
      remediation: "Check the Registry response and connection, then retry.",
    };
  return {
    message: `${contract} does not match the SKIT API contract: ${Match.value(reason).pipe(
      Match.tagsExhaustive({
        InvalidData: ({ failure }) => schemaFailure(failure),
        InvalidTree: ({ issue }) => treePathIssue(issue),
        InvalidWriteTarget: ({ path }) =>
          `${path}: expected a canonical relative content path outside control directories`,
        UnsupportedTreeEntry: ({ path, kind }) =>
          `${path}: Author sync writes files only; the SKIT holds a ${kind} here`,
      }),
    )}`,
    remediation: ["InvalidTree", "InvalidWriteTarget", "UnsupportedTreeEntry"].includes(reason._tag)
      ? "Keep the local files and history; report this invalid author sync tree."
      : "Check that the Registry runs a compatible SKIT server, then retry.",
  };
};
