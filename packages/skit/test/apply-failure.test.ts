import { expectTypeOf, test, expect } from "vitest";
import { Schema } from "effect";
import { ApplyFailure } from "../src/library/apply-failure.js";
import type { ApplyError } from "../src/library/library-plan.js";
import { systemError } from "effect/PlatformError";
import { SetEnabledIncomplete } from "../src/library/internal/session/set-enabled.js";

test("the application codec covers precisely the Library's application error union", () => {
  expectTypeOf<ApplyError>().toEqualTypeOf<typeof ApplyFailure.Type>();
});

test("an incomplete enable stores the actual filesystem refusal, retaining its operation code", () => {
  const failure = systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "writeFile",
    pathOrDescriptor: "/skills/review/SKILL.md",
  });
  const incomplete = new SetEnabledIncomplete({ results: [], reason: "update", failure });
  const encoded = Schema.encodeSync(SetEnabledIncomplete)(incomplete);
  expect(encoded).not.toHaveProperty("message");
  expect(encoded).not.toHaveProperty("remediation");
  expect(encoded.failure).toEqual({
    _tag: "PlatformError",
    reason: {
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "writeFile",
      pathOrDescriptor: "/skills/review/SKILL.md",
    },
  });
  const decoded = Schema.decodeUnknownSync(SetEnabledIncomplete)(
    JSON.parse(JSON.stringify(encoded)),
  );
  expect(decoded.code).toBe("OPERATION_FAILED");
  expect(decoded.failure._tag).toBe("PlatformError");
});
