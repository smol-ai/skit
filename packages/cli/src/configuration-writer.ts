import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect } from "effect";
import { withLibraryWriterLock } from "@smolai/skit-core";

/** Explicit command overrides take precedence over the runtime's ConfigProvider. */
export const configurationHome = Effect.fn("Configuration.home")(function* (home?: string) {
  if (home !== undefined) return home;
  return yield* Config.String("SKIT_HOME").pipe(Config.withDefault(join(homedir(), ".skit")));
});

/** Serialize root configuration writes with other writers without loading Library state or
 * recording a Library history event. The same storage mutex preserves existing exclusion. */
export function withConfigurationWriter<A, E, R>(
  home: string | undefined,
  program: Effect.Effect<A, E, R>,
) {
  return Effect.flatMap(configurationHome(home), (root) =>
    withLibraryWriterLock(root, Effect.scoped(program)),
  );
}
