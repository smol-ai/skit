import { expect, test } from "vitest";
import { Schema } from "effect";
import { HelpDocumentMissing } from "../src/commands/help-failures.js";
import { UpdateCheckTimedOut } from "../src/platform/release-failures.js";
import { FindingFingerprintInvalid } from "../src/library/security/failures.js";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { Block } from "../src/terminal/blocks.js";

const Failure = Schema.Union([HelpDocumentMissing, UpdateCheckTimedOut, FindingFingerprintInvalid]);

for (const failure of [
  new HelpDocumentMissing({ command: "security review" }),
  new UpdateCheckTimedOut({ source: "https://registry.test/dist-tags", timeoutMs: 1_500 }),
  new FindingFingerprintInvalid({ value: "sha256:short" }),
]) {
  test(`${failure._tag} keeps its facts through JSON and uses its owner presentation`, () => {
    const wire = Schema.encodeSync(Failure)(failure);
    const decoded = Schema.decodeUnknownSync(Failure)(JSON.parse(JSON.stringify(wire)));
    expect(decoded).toMatchObject(wire);
    expect(wire).not.toHaveProperty("message");
    expect(wire).not.toHaveProperty("remediation");
    expect(classifyFailure(decoded).presentation).toEqual(classifyFailure(failure).presentation);
    expect(classifyFailure(decoded).next.length).toBeGreaterThan(0);
  });
}

test("invalid fingerprints retain the supplied value and the actual required prefix", () => {
  const description = classifyFailure(new FindingFingerprintInvalid({ value: "sha256:short" }));
  expect(description.explanation).toContainEqual(
    Block.Fields({ rows: [{ label: "Fingerprint", value: [{ code: "sha256:short" }] }] }),
  );
  expect(description.explanation).toContainEqual(
    Block.Note({
      text: [
        "A fingerprint starts with ",
        { code: "sha256:" },
        " followed by 64 lowercase hexadecimal characters.",
      ],
    }),
  );
  expect(description.next).toContainEqual({ code: "skit security review <skill>" });
});
