import { Effect } from "effect";
import { configurationPaths, SkitPaths } from "./configuration/paths.js";
import { withLibraryWriterLock } from "@smolai/skit-core";

/** Serialize root configuration writes with other writers without loading Library state or
 * recording a Library history event. The same storage mutex preserves existing exclusion. */
export function withConfigurationWriter<A, E, R>(
  home: string | undefined,
  program: Effect.Effect<A, E, R>,
) {
  return Effect.flatMap(configurationPaths(home), (paths) =>
    withLibraryWriterLock(paths.skitHome, Effect.scoped(program)).pipe(
      Effect.provideService(SkitPaths, paths),
    ),
  );
}
