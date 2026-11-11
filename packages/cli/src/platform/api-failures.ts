import { describeFailure } from "../terminal/failure.js";
import { SkitContractError } from "@smolai/skit-core/api";
import { Match } from "effect";
import { schemaFailureMessages } from "./schema-failure.js";
import { treePathIssue } from "./history-failures.js";
import { Block } from "../terminal/blocks.js";
import { errorMessage } from "@smolai/skit-core/shared";

export const apiContractFailure = ({ contract, reason }: SkitContractError) => {
  if (reason._tag === "InvalidData")
    return describeFailure({
      summary: [{ code: contract }, " does not match the SKIT API contract"],
      details: [
        Block.List({
          items: schemaFailureMessages(reason.failure).map((message) => ({ text: [message] })),
        }),
      ],
      next: ["Check that the Registry runs a compatible SKIT server, then retry."],
    });
  if (reason._tag === "ReadFailed")
    return describeFailure({
      summary: ["Unable to read ", { code: contract }],
      details: [Block.Note({ text: [errorMessage(reason.failure)] })],
      next: ["Check the Registry response and connection, then retry."],
    });
  return describeFailure({
    summary: [
      `${contract} does not match the SKIT API contract: ${Match.value(reason).pipe(
        Match.tagsExhaustive({
          InvalidTree: ({ issue }) => treePathIssue(issue),
          InvalidWriteTarget: ({ path }) =>
            `${path}: expected a canonical relative content path outside control directories`,
          UnsupportedTreeEntry: ({ path, kind }) =>
            `${path}: Author sync writes files only; the SKIT holds a ${kind} here`,
        }),
      )}`,
    ],
    next: ["Keep the local files and history; report this invalid author sync tree."],
  });
};
