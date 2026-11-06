import { Effect } from "effect";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { initializeAuthorWorkspace } from "@smolai/skit-core/author";

export const authorInitCommand = Effect.fn("CLI.authorInit")(function* (input: string) {
  return yield* initializeAuthorWorkspace(input, (yield* SkitConfiguration).skitHome);
});
