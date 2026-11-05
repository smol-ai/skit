import {
  scanUsage,
  UsageHarness,
  harnessDrivers,
  type LibraryState,
  type UsageRoot,
  type UsageOptions,
} from "@smolai/skit-core";
import { Config, Effect } from "effect";
import { join, resolve } from "node:path";

/** Own transcript discovery and managed-document attribution for local usage consumers. */
export const scanLocalUsage = Effect.fn("LocalUsage.scan")(function* (
  state: LibraryState,
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
  const skills = new Map(state.skills.map((skill) => [skill.skill_id, skill]));
  return yield* scanUsage({
    roots,
    days: options.days,
    end: options.end,
    project: options.project,
    progress: options.progress,
    installedSkills: state.installed_skills.flatMap((installedSkill) => {
      const skill = skills.get(installedSkill.skill_id);
      return skill
        ? [{ path: installedSkill.path, skillId: skill.skill_id, name: skill.name }]
        : [];
    }),
  });
});
