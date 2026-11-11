import {
  AuthorWorkspaceInvariantFailed,
  WorkspaceRoot,
} from "@smolai/skit-core/author/workspace-contracts";
import { expect, test } from "vitest";
import { Cause, Schema } from "effect";
import { ArchiveStreamInvalid } from "@smolai/skit-core/universal/consumer";
import { StepDefect } from "@smolai/skit-core/library/recorded-failures";
import {
  commandError,
  commandFailure,
  classifyFailure,
} from "../src/commands/failure-classification.js";
import { CommandError } from "../src/commands/error-output.js";

const cases = [
  {
    failure: new AuthorWorkspaceInvariantFailed({
      root: WorkspaceRoot.make("/author"),
      reason: { _tag: "LeaseClosed" },
    }),
    message: "An author operation used a workspace lease after it closed",
  },
  {
    failure: new ArchiveStreamInvalid({ path: "/work/release.zip" }),
    message: "ZIP writer supplied an unsupported output stream",
  },
];

test.each(cases)(
  "command JSON preserves defect facts and semantic fields: $message",
  ({ failure, message }) => {
    const cause = Cause.die(failure);
    const error = commandError(cause);
    expect(error.cause).toBe(cause);
    const wire = Schema.encodeSync(CommandError)(error);
    expect(JSON.stringify(wire)).not.toContain('"message"');
    const stored = Schema.decodeUnknownSync(CommandError)(JSON.parse(JSON.stringify(wire)));
    expect(stored.cause.reasons[0]?._tag).toBe("Die");
    const live = commandFailure(cause);
    const decoded = commandFailure(stored.cause);
    expect(live.cause).toBe(cause);
    expect(decoded.message).toBe(live.message);
    expect(decoded.message).toContain(message);
    expect(decoded.explanation).toContainEqual(expect.objectContaining({ _tag: "Fields" }));
    expect(decoded.remediation).toContain("Report this failure");
  },
);

test.each(cases)(
  "recorded defects keep their explanation and stopped-operation guidance: $message",
  ({ failure, message }) => {
    const recorded = new StepDefect({ defect: failure });
    const stored = Schema.decodeUnknownSync(StepDefect)(
      JSON.parse(JSON.stringify(Schema.encodeSync(StepDefect)(recorded))),
    );
    expect(recorded.defect).toBe(failure);
    const output = classifyFailure(stored);
    expect(output.message).toContain(message);
    expect(output.remediation).toContain("Review the stopped operation");
    expect(output.explanation).toContainEqual(expect.objectContaining({ _tag: "Group" }));
  },
);
