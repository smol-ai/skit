import { Effect } from "effect";
import { InstalledSkills, Library } from "@smolai/skit-core";

/**
 * The Library owner for work that needs no install routing: imports. Anything needing this
 * device's destinations fails rather than guessing.
 */
export const localLibrary = Effect.gen(function* () {
  return yield* Library.make.pipe(
    Effect.provideService(InstalledSkills.Service, yield* InstalledSkills.make()),
  );
});
