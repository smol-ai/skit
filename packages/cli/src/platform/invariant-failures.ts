import {
  AuthorWorkspaceInvariantFailed,
  AuthorWorkspaceInvariantReason,
} from "@smolai/skit-core/author/workspace-contracts";
import { Schema } from "effect";
import { ArchiveStreamInvalid } from "@smolai/skit-core/universal/consumer";
import { Block } from "../terminal/blocks.js";
import { describeFailure } from "../terminal/failure.js";

const next = ["Report this failure to SKIT's maintainers."];

const archiveInvariantFailure = ({ path }: ArchiveStreamInvalid) =>
  describeFailure({
    summary: ["ZIP writer supplied an unsupported output stream"],
    details: [Block.Fields({ rows: [{ label: "Archive", value: [{ path }] }] })],
    next,
  });

/** A closed owner schema recognizes a known defect; arbitrary native exceptions stay untouched. */
export const invariantFailure = (error: unknown) => {
  if (Schema.is(AuthorWorkspaceInvariantFailed)(error))
    return describeFailure({
      summary: [
        AuthorWorkspaceInvariantReason.match(error.reason, {
          LeaseClosed: () => "An author operation used a workspace lease after it closed",
          WriteNotOwned: () => "An author write used a checkpoint from another workspace lease",
          CheckpointChanged: () => "An author write used a checkpoint after another state change",
          WriteAlreadyUsed: () => "An author write operation was applied more than once",
          TreesDiffer: () => "An author write supplied files outside its saved checkpoint",
        }),
      ],
      details: [Block.Fields({ rows: [{ label: "Workspace", value: [{ path: error.root }] }] })],
      next,
    });
  if (Schema.is(ArchiveStreamInvalid)(error)) return archiveInvariantFailure(error);
  return undefined;
};
