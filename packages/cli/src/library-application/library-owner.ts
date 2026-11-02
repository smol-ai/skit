import { Effect } from "effect";
import {
  InstalledSkills,
  InstalledSkillsNode,
  Library,
  type LibraryState,
} from "@smolai/skit-core";

/**
 * The Library owner for work that needs no install routing: imports. Anything needing this
 * device's destinations fails rather than guessing.
 */
export const localLibrary = Effect.gen(function* () {
  return yield* Library.make.pipe(
    Effect.provideService(InstalledSkills.Service, yield* InstalledSkillsNode.make()),
  );
});

/**
 * The Library owner routed where this device already has copies: for work that changes no
 * routes, such as removing a Collection or updating copies in place.
 */
export const recordedLibrary = Effect.fn("Library.recorded")(function* (state: LibraryState) {
  return yield* Library.make.pipe(
    Effect.provideService(
      InstalledSkills.Service,
      yield* InstalledSkillsNode.make(yield* InstalledSkillsNode.recordedRouting(state)),
    ),
  );
});
