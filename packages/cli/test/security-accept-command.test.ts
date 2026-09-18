import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { securityAcceptCommand } from "../src/handlers/security/accept.js";

it.effect("requires the Skill and acceptance fields", () =>
  Effect.gen(function* () {
    const library = { acceptSecurityFindingEffect: () => Effect.die("unreachable") };
    const missingSkill = yield* securityAcceptCommand(library, {}).pipe(Effect.flip);
    if (missingSkill._tag !== "MissingRequirement") return assert.fail(missingSkill._tag);
    assert.strictEqual(missingSkill.requires, "<skill>");

    const missingFields = yield* securityAcceptCommand(library, { query: "review" }).pipe(
      Effect.flip,
    );
    if (missingFields._tag !== "MissingRequirement") return assert.fail(missingFields._tag);
    assert.strictEqual(missingFields.requires, "--finding, --principal, and --rationale");
  }),
);

it.effect("rejects a malformed finding fingerprint as typed command input", () =>
  securityAcceptCommand(
    { acceptSecurityFindingEffect: () => Effect.die("unreachable") },
    {
      query: "review",
      fingerprint: "sha256:short",
      principal: "tim",
      rationale: "reviewed",
    },
  ).pipe(
    Effect.flip,
    Effect.map((failure) => {
      if (failure._tag !== "FindingFingerprintInvalid") return assert.fail(failure._tag);
      assert.strictEqual(failure.value, "sha256:short");
    }),
  ),
);
