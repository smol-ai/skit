import { expect, it } from "vitest";
import { Schema } from "effect";
import { systemError } from "effect/PlatformError";
import { InvalidUsageOptions } from "@smolai/skit-core/library/usage/contracts";
import { classifyFailure } from "../src/commands/failure-classification.js";

it("retains every rejected days value across JSON and supplies the allowed range in the CLI", () => {
  for (const days of [0, -1, 1.5, 3651, NaN, Infinity, -Infinity]) {
    const failure = new InvalidUsageOptions({ reason: { _tag: "InvalidDays", days } });
    const wire = Schema.encodeSync(Schema.toCodecJson(InvalidUsageOptions))(failure);
    const decoded = Schema.decodeUnknownSync(InvalidUsageOptions)(JSON.parse(JSON.stringify(wire)));
    expect(decoded.reason._tag).toBe("InvalidDays");
    if (decoded.reason._tag === "InvalidDays") expect(decoded.reason.days).toBe(days);
    const formatted = classifyFailure(decoded);
    expect(formatted.code).toBe("INVALID_ARGUMENT");
    expect(formatted.message).toContain("1 and 3650");
    expect(formatted.remediation).toContain("skit usage --help");
  }
});

it("distinguishes an invalid date, an unsupported window and an unreadable or non-directory project", () => {
  const failures = [
    new InvalidUsageOptions({ reason: { _tag: "InvalidEnd", end: "tomorrow-ish" } }),
    new InvalidUsageOptions({
      reason: { _tag: "DateRangeExceeded", end: "-271821-04-20T00:00:00Z", days: 7 },
    }),
    new InvalidUsageOptions({
      reason: { _tag: "ProjectNotDirectory", path: "/work/review", kind: "File" },
    }),
    new InvalidUsageOptions({
      reason: {
        _tag: "ProjectUnreadable",
        path: "/work/review",
        failure: systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "stat",
          pathOrDescriptor: "/work/review",
        }),
      },
    }),
  ];
  const messages = failures.map((failure) => classifyFailure(failure).message);
  expect(messages[0]).toContain("tomorrow-ish");
  expect(messages[1]).toContain("supported date range");
  expect(messages[2]).toContain("file");
  expect(messages[3]).toContain("PermissionDenied");
});
