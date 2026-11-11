import { expect, test } from "vitest";
import { Schema } from "effect";
import { ArchiveStreamInvalid } from "@smolai/skit-core/universal/consumer";
import { StepDefect } from "@smolai/skit-core/library/recorded-failures";
import { libraryFailure } from "../src/library/failures";

test.each([
  {
    failure: new ArchiveStreamInvalid({ path: "/work/release.zip" }),
    message: "ZIP writer supplied an unsupported output stream",
  },
])("TUI explains live and recorded owner invariants: $message", ({ failure, message }) => {
  const recorded = new StepDefect({ defect: failure });
  const stored = Schema.decodeUnknownSync(StepDefect)(
    JSON.parse(JSON.stringify(Schema.encodeSync(StepDefect)(recorded))),
  );
  expect(libraryFailure(failure)).toContain(message);
  expect(libraryFailure(stored)).toContain(message);
  expect(libraryFailure(stored)).toContain("Review the stopped operation");
});
