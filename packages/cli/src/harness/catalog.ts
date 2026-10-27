import { configurationForHome } from "../configuration/skit-configuration.js";
import { Effect } from "effect";
import { LinkStat } from "@smolai/skit-core";
import { dirname, join } from "node:path";
import {
  HarnessName,
  harnessDrivers,
  resolveSkillsDirectory,
  type SkillsDirectoryOverrides,
} from "@smolai/skit-core";

export function harnessLabel(harness: HarnessName): string {
  return harnessDrivers[harness].label;
}

export interface HarnessProbeOptions {
  home: string;
  configHome?: string;
  overrides?: SkillsDirectoryOverrides;
  /** Whether a filesystem marker is present. Detection is a pure decision over this probe. */
  exists: (path: string) => boolean;
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

/** The detection policy over an answered marker probe; `detectInstalledHarnessesEffect` asks the filesystem. */
export function detectInstalledHarnesses(options: HarnessProbeOptions): HarnessName[] {
  const context = {
    home: options.home,
    configHome: options.configHome ?? join(options.home, ".config"),
  };
  return HarnessName.literals.filter(
    (harness) =>
      (harnessDrivers[harness].rootOverride === "replaces" &&
        Boolean(options.overrides?.[harness]?.some(Boolean))) ||
      installMarkers(harness, context).some(options.exists),
  );
}

/** Resolve the same synchronous detection policy with application-owned filesystem probes. */
export const detectInstalledHarnessesEffect = Effect.fn("Harness.detectInstalled")(function* (
  options: Partial<Omit<HarnessProbeOptions, "exists">> = {},
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
  return detectInstalledHarnesses({
    ...options,
    home,
    configHome,
    exists: (path) => found.has(path),
  });
});
