import { failureExitCode } from "../src/commands/exit-code.js";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { DescriptorMalformed } from "@smolai/skit-core/author";
import { AuthorWorkspaceUnsafe } from "@smolai/skit-core/author/workspace-contracts";
import { commandFailure } from "../src/commands/failure-classification.js";

it.effect(
  "original tagged errors and native causes reach command formatting after scopes close",
  () =>
    Effect.gen(function* () {
      for (const native of [
        Object.assign(new Error("native failure"), { errno: null }),
        { message: "native failure", errno: null },
        "native failure",
      ]) {
        const owner = new AuthorWorkspaceUnsafe({
          path: "/author/.skit/lock.sqlite",
          reason: { _tag: "LockFailed", cause: native },
        });
        let finalized = false;
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalized = true;
              }),
            );
            return yield* owner;
          }),
        ).pipe(Effect.exit);
        expect(finalized).toBe(true);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isSuccess(result)) return;
        expect(result.cause.reasons).toHaveLength(1);
        const reason = result.cause.reasons[0];
        if (reason === undefined || !Cause.isFailReason(reason)) return;
        expect(reason.error).toBe(owner);
        if (reason.error.reason._tag !== "LockFailed") return;
        expect(reason.error.reason.cause).toBe(native);
        expect(commandFailure(result.cause)).toMatchObject({
          message: expect.stringContaining("native failure"),
        });
      }
    }),
);

it.effect(
  "live descriptor formatting consumes the original Effect schema error and its issue tree",
  () =>
    Effect.gen(function* () {
      const native = yield* Schema.decodeUnknownEffect(Schema.Struct({ requestId: Schema.String }))(
        { requestId: 42 },
      ).pipe(Effect.flip);
      const owner = new DescriptorMalformed({
        format: "json",
        issue: { _tag: "Schema", failure: native },
      });
      expect(owner.issue._tag).toBe("Schema");
      if (owner.issue._tag !== "Schema") return;
      expect(owner.issue.failure).toBe(native);
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          return yield* owner;
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isSuccess(result)) return;
      expect(result.cause.reasons).toHaveLength(1);
      const reason = result.cause.reasons[0];
      if (reason === undefined || !Cause.isFailReason(reason)) return;
      expect(reason.error).toBe(owner);
      const formatted = commandFailure(result.cause);
      expect(failureExitCode(formatted.code)).toBe(1);
      expect(formatted.message).toContain("requestId");
      expect(owner.issue.failure).toBe(native);
    }),
);
