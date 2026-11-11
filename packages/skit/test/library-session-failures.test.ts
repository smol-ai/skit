import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { InvocationUnavailable } from "../src/library/invocation-failure.js";
import { TreeError } from "../src/shared/tree-error.js";
import {
  proposeLibraryInvocation,
  type LibrarySkillRow,
} from "../src/library/internal/session/session.js";

it.effect(
  "an unreadable author preference keeps the validation code and the full reader failure",
  () =>
    Effect.gen(function* () {
      const failure = new TreeError({
        reason: { _tag: "ChangedDuringRead", path: "/source/review" },
      });
      const row: LibrarySkillRow = {
        name: "review",
        skillId: "skill",
        skillVersionId: "version",
        collectionId: "collection",
        heading: "review",
        source: null,
        revision: null,
        source_updated_at: null,
        imported_at: null,
        authorInvocation: Result.fail(failure),
        invocationFailure: failure,
        scopes: [],
      };
      const next = yield* proposeLibraryInvocation(
        { skills: [row] },
        row,
        { scope: { kind: "global" }, invocation: "declared" },
        "explicit",
      );
      expect(next.pending).toBeUndefined();
      expect(next.outcome?.kind).toBe("failed");
      if (next.outcome?.kind !== "failed") throw new Error("Expected a failed policy change");
      expect(Schema.is(InvocationUnavailable)(next.outcome.failure)).toBe(true);
      if (!Schema.is(InvocationUnavailable)(next.outcome.failure))
        throw new Error("Expected validation refusal");
      expect(next.outcome.failure.code).toBe("VALIDATION_FAILED");
      expect(next.outcome.failure.failure).toBe(failure);
      const encoded = Schema.encodeSync(InvocationUnavailable)(next.outcome.failure);
      expect(encoded).toEqual({
        _tag: "Library.InvocationUnavailable",
        failure: {
          _tag: "TreeError",
          reason: { _tag: "ChangedDuringRead", path: "/source/review" },
        },
      });
    }),
);
