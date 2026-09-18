// Effect's errno mapping is lossy, so errno branching must read the original code. These pin the
// two cases where the reason tag would give the wrong answer.

import { describe, expect, test } from "vitest";
import { errnoOf, isErrno } from "../src/platform/errno.js";

function platformError(code: string, tag: string) {
  const cause = Object.assign(new Error(`${code}: failed`), { code });
  return { _tag: "PlatformError", reason: { _tag: tag, cause } };
}

describe("errno inspection", () => {
  test("reads a bare node errno", () => {
    expect(errnoOf(Object.assign(new Error("nope"), { code: "ENOENT" }))).toBe("ENOENT");
  });

  test("reads an errno wrapped in a PlatformError", () => {
    expect(errnoOf(platformError("ENOENT", "NotFound"))).toBe("ENOENT");
  });

  test("EPERM survives, though Effect maps it to Unknown", () => {
    expect(isErrno(platformError("EPERM", "Unknown"), "EACCES", "EPERM")).toBe(true);
  });

  test("ENOTDIR survives, though Effect maps it to BadResource not NotFound", () => {
    expect(isErrno(platformError("ENOTDIR", "BadResource"), "ENOENT", "ENOTDIR")).toBe(true);
  });

  test("an unrelated failure reports no errno", () => {
    expect(errnoOf(new Error("plain"))).toBeUndefined();
    expect(isErrno(undefined, "ENOENT")).toBe(false);
  });
});
