import {
  scanUsage,
  UsageHarness,
  type UsageRoot,
  type UsageOptions,
  type InstalledSkillUsage,
} from "@smolai/skit-core/library/usage";
import { harnessDrivers } from "@smolai/skit-core/harnesses";
import { Config, Effect } from "effect";
import { join, resolve } from "node:path";

/** Own transcript discovery and managed-document attribution for local usage consumers. */
export const scanLocalUsage = Effect.fn("LocalUsage.scan")(function* (
  installedSkills: readonly InstalledSkillUsage[],
  options: Omit<UsageOptions, "roots" | "installedSkills"> & {
    readonly userHome: string;
    readonly harness?: UsageHarness | "all";
    readonly homes?: Partial<Record<UsageHarness, string>>;
  },
) {
  const roots: UsageRoot[] = [];
  for (const harness of UsageHarness.literals) {
    if (options.harness && options.harness !== "all" && options.harness !== harness) continue;
    const transcripts = harnessDrivers[harness].transcripts;
    const home =
      options.homes?.[harness] ??
      (yield* Config.String(transcripts.home.variable).pipe(
        Config.withDefault(join(options.userHome, transcripts.home.directory)),
      ));
    for (const directory of transcripts.directories)
      roots.push({ harness, root: join(resolve(home), directory) });
  }
  return yield* scanUsage({
    roots,
    days: options.days,
    end: options.end,
    project: options.project,
    progress: options.progress,
    installedSkills,
  });
});
