import { Effect } from "effect";
import { configurationForHome, SkitConfiguration } from "./configuration/skit-configuration.js";
import { withLibraryWriterLock } from "@smolai/skit-core";

/** Serialize root configuration writes with other writers without loading Library state or
 * recording a Library history event. The same storage mutex preserves existing exclusion. */
export function withConfigurationWriter<A, E, R>(
  home: string | undefined,
  program: Effect.Effect<A, E, R>,
) {
  return Effect.flatMap(configurationForHome(home), (paths) =>
    withLibraryWriterLock(paths.skitHome, Effect.scoped(program)).pipe(
      Effect.provideService(SkitConfiguration, paths),
    ),
  );
}
