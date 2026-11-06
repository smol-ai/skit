import { Effect, Result } from "effect";
import * as Library from "../../library.js";

/** Saved-file recovery operations this Library recorded. Never writes. */
export const listLibraryRecovery = Effect.fn("Library.recovery.list")(function* () {
  return yield* (yield* Library.Service).recovery.list;
});

/** Move records and the original and saved files of one operation, unchanged. */
export const inspectLibraryRecovery = Effect.fn("Library.recovery.inspect")(function* (
  operationId: string,
) {
  return yield* (yield* Library.Service).recovery.inspect(operationId);
});

/**
 * Plan restoring one operation's saved files into free original paths. The plan ID is the
 * caller's consent: applying reports the files as they stand afterwards, whether or not the
 * restore completed, so a frontend never has to inspect again to say what happened.
 */
export const openRecoveryRestore = Effect.fn("Library.recovery.openRestore")(function* (
  operationId: string,
) {
  const library = yield* Library.Service;
  const plan = yield* library.plan({ _tag: "Restore", operationId }, { base: yield* library.read });
  return {
    change: plan.change,
    apply: Effect.gen(function* () {
      const applied = yield* Effect.result(library.apply({ _tag: "Apply", plan }));
      if (Result.isSuccess(applied))
        return { _tag: "Applied" as const, inspection: applied.success.result.after };
      return {
        _tag: "Failed" as const,
        failure: applied.failure,
        inspection: yield* library.recovery.inspect(operationId),
      };
    }),
  };
});
