import { Effect } from "effect";
import { LinkStat } from "../platform/link-stat.js";
import { dirname } from "node:path";
import { HarnessName, type SkillsDirectoryOverrides } from "./contracts.js";
import { harnessDrivers } from "./drivers.js";
import { resolveSkillsDirectory } from "./catalog.js";

export function harnessLabel(harness: HarnessName): string {
  return harnessDrivers[harness].label;
}

/** The filesystem markers whose presence shows a Harness installed. */
function installMarkers(harness: HarnessName, context: { home: string; configHome: string }) {
  const driver = harnessDrivers[harness];
  const native = Object.values(driver.profile.roots)
    .filter((root) => root.scope === "global")
    .find((root) => root.role === "native");
  return [
    ...(native ? [dirname(resolveSkillsDirectory({ ...native, ...context }))] : []),
    ...driver.installMarkers,
  ];
}

/** The Harnesses installed on this device: those with a marker on disk or a replacing override. */
export interface InstalledHarnessOptions {
  readonly home: string;
  readonly configHome: string;
  readonly overrides?: SkillsDirectoryOverrides;
}

export const detectInstalledHarnesses = Effect.fn("Harness.detectInstalled")(function* (
  options: InstalledHarnessOptions,
) {
  const { home, configHome } = options;
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
