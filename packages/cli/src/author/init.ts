import { Effect } from "effect";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { authorLayer, initializeAuthorWorkspace } from "@smolai/skit-core/author";

export const authorInitCommand = Effect.fn("CLI.authorInit")(function* (input: string) {
  const home = (yield* SkitConfiguration).skitHome;
  return yield* initializeAuthorWorkspace(input, home).pipe(Effect.provide(authorLayer({ home })));
});
