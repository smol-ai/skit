import { configurationForHome } from "../configuration/skit-configuration.js";
import { Effect } from "effect";
import { LinkStat } from "@smolai/skit-core";
import { dirname } from "node:path";
import {
  HarnessName,
  harnessDrivers,
  resolveSkillsDirectory,
  type SkillsDirectoryOverrides,
} from "@smolai/skit-core";

export function harnessLabel(harness: HarnessName): string {
  return harnessDrivers[harness].label;
}

/** The filesystem markers whose presence shows a Harness installed. */
function installMarkers(harness: HarnessName, context: { home: string; configHome: string }) {
  const driver = harnessDrivers[harness];
  const native = driver.profile.roots.find(
    (root) => root.scope === "global" && root.role === "native",
  );
  return [
    ...(native ? [dirname(resolveSkillsDirectory(native, context))] : []),
    ...driver.installMarkers,
  ];
}

/** The Harnesses installed on this device: those with a marker on disk or a replacing override. */
export const detectInstalledHarnesses = Effect.fn("Harness.detectInstalled")(function* (
  options: { home?: string; configHome?: string; overrides?: SkillsDirectoryOverrides } = {},
) {
  const configuration = yield* configurationForHome();
  const home = options.home ?? configuration.userHome;
  const configHome = options.configHome ?? configuration.configHome;
  const probe = yield* LinkStat;
  const found = new Set<string>();
  yield* Effect.forEach(
    HarnessName.literals.flatMap((harness) => installMarkers(harness, { home, configHome })),
    (path) =>
      Effect.option(probe.identity.lstat(path)).pipe(
        Effect.map((info) => {
          if (info._tag === "Some") found.add(path);
        }),
      ),
    { concurrency: "unbounded", discard: true },
  );
  return HarnessName.literals.filter(
    (harness) =>
      (harnessDrivers[harness].rootOverride === "replaces" &&
        Boolean(options.overrides?.[harness]?.some(Boolean))) ||
      installMarkers(harness, { home, configHome }).some((path) => found.has(path)),
  );
});
