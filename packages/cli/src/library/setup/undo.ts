import { Effect } from "effect";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { prepareSetupUndo as prepareCoreSetupUndo } from "@smolai/skit-core/library/setup";

export const prepareSetupUndo = Effect.fn("CLI.setupUndo.prepare")(function* (operationId: string) {
  return yield* prepareCoreSetupUndo((yield* SkitConfiguration).skitHome, operationId);
});
