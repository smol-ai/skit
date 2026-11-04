import { Effect } from "effect";
import { prepareSetupUndo as prepare } from "@smolai/skit-core/library/setup";
import { SkitConfiguration } from "@smolai/skit-core";

/** Supply executable paths to the shared review of both owners. */
export const prepareSetupUndo = Effect.fn("CLI.setupUndo.prepare")(function* (operationId: string) {
  return yield* prepare((yield* SkitConfiguration).skitHome, operationId);
});
