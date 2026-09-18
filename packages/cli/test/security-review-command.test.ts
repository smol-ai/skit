import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { securityReviewCommand } from "../src/handlers/security/review.js";

it.effect("requires an exact retained Skill", () =>
  securityReviewCommand({ securityReviewEffect: () => Effect.die("unreachable") }).pipe(
    Effect.flip,
    Effect.map((failure) => {
      assert.strictEqual(failure._tag, "MissingRequirement");
      assert.strictEqual(failure.requires, "<skill>");
    }),
  ),
);
