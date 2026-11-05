import { Effect } from "effect";
import { configurationForHome } from "@smolai/skit-core";
import {
  detectInstalledHarnesses as detect,
  type InstalledHarnessOptions,
} from "@smolai/skit-core/harnesses";

/** The executable boundary supplies defaults; shared detection receives concrete paths. */
export const detectInstalledHarnesses = Effect.fn("CLI.detectInstalledHarnesses")(function* (
  options: Partial<InstalledHarnessOptions> = {},
) {
  const configuration = yield* configurationForHome();
  return yield* detect({
    home: options.home ?? configuration.userHome,
    configHome: options.configHome ?? configuration.configHome,
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
  });
});
