import { Schema } from "effect";
import { gt, prerelease, valid } from "semver";
import { BuildInfo } from "@smolai/skit-core/shared";

export const ReleaseCheck = Schema.Struct({
  status: Schema.Literals([
    "current",
    "update-available",
    "ahead",
    "channel-unavailable",
    "check-unavailable",
    "development-build",
  ]),
  channel: Schema.String,
  source: Schema.String,
  available: Schema.optionalKey(Schema.String),
  checkedAt: Schema.optionalKey(Schema.Number),
  reason: Schema.optionalKey(Schema.String),
  upgrade: Schema.optionalKey(Schema.String),
});
export type ReleaseCheck = typeof ReleaseCheck.Type;
export const VersionReport = Schema.Struct({
  version: Schema.String,
  build: BuildInfo,
  update: ReleaseCheck,
});
export const defaultChannel = (version: string): string => {
  const identifier = prerelease(version)?.[0];
  return identifier === "alpha" || identifier === "beta" || identifier === "rc"
    ? identifier
    : "latest";
};
export function decideRelease(
  build: BuildInfo,
  tags: Readonly<Record<string, string>>,
  channel: string,
  source: string,
): ReleaseCheck {
  if (build.kind === "dev") return { status: "development-build", channel, source };
  if (!valid(build.version))
    return {
      status: "check-unavailable",
      channel,
      source,
      reason: "Installed version is not valid SemVer.",
    };
  const selected = tags[channel];
  const stable = tags.latest;
  // A misplaced prerelease on latest must never be offered as a stable upgrade.
  const usable =
    selected && valid(selected) && (channel !== "latest" || !prerelease(selected))
      ? selected
      : undefined;
  let available = usable;
  let target = channel;
  if (
    prerelease(build.version) &&
    stable &&
    valid(stable) &&
    !prerelease(stable) &&
    gt(stable, build.version) &&
    (!available || gt(stable, available))
  ) {
    available = stable;
    target = "latest";
  }
  if (!available) return { status: "channel-unavailable", channel, source };
  const status = gt(available, build.version)
    ? "update-available"
    : gt(build.version, available)
      ? "ahead"
      : "current";
  return {
    status,
    channel,
    source,
    available,
    ...(status === "update-available" ? { upgrade: `npm install -g @smolai/skit@${target}` } : {}),
  };
}
export { passiveCheckEnabled } from "./releases/policy.js";
