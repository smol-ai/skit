import { RegistryNotConfigured } from "@smolai/skit-core/library/source/failures";
import { failureExitCode } from "../src/commands/exit-code.js";
import { expect, test } from "vitest";
import { Schema } from "effect";
import {
  SourceFailure,
  GitSourceFragment,
  UnsafeArchivePath,
  SourceNotFound,
} from "@smolai/skit-core/library/source";
import { classifyFailure } from "../src/commands/failure-classification.js";

test("source validation retains the rejected value through encoding and frontend formatting", () => {
  for (const [error, exitCode, fact] of [
    [
      new GitSourceFragment({ source: "https://github.com/team/tools.git#review" }),
      2,
      "https://github.com/team/tools.git#review",
    ],
    [new UnsafeArchivePath({ path: "../escape" }), 1, "../escape"],
    [new SourceNotFound({ source: "/missing/tools" }), 1, "/missing/tools"],
  ] as const) {
    const encoded = Schema.encodeSync(SourceFailure)(error);
    expect(encoded).not.toHaveProperty("message");
    expect(encoded).not.toHaveProperty("remediation");
    const decoded = Schema.decodeUnknownSync(SourceFailure)(JSON.parse(JSON.stringify(encoded)));
    const formatted = classifyFailure(decoded);
    expect(failureExitCode(formatted.code)).toBe(exitCode);
    expect(formatted.code).toBe(error.code);
    expect(formatted.message).toContain(fact);
    expect(formatted.remediation).not.toBe("Check the reported failure and retry.");
  }
});

test("Registry selection is data in core and guidance in the CLI", () => {
  const failure = new RegistryNotConfigured();
  const wire = Schema.encodeSync(RegistryNotConfigured)(failure);
  expect(wire).toEqual({ _tag: "RegistryNotConfigured" });
  expect(classifyFailure(failure)).toMatchObject({
    code: "INVALID_ARGUMENT",
    message: "No SKIT Registry is configured.",
    remediation: expect.stringContaining("skit auth login <registry-url>"),
  });
});
