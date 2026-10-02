import { Data, Schema } from "effect";
import { sourceLocator, SkitSource } from "@smolai/skit-core";
import type { SetupLockMatch } from "./setup-contract.js";

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const safeSkillPath = (path: string | undefined): path is string =>
  !!path &&
  path.endsWith("/SKILL.md") &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((segment) => segment && segment !== "." && segment !== "..");

function githubRepository(lock: SetupLockMatch): { owner: string; repository: string } | undefined {
  if (lock.entry.sourceType !== "github") return undefined;
  for (const claim of [lock.entry.source, lock.entry.sourceUrl]) {
    if (!claim) continue;
    const match =
      claim.match(/^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/i) ??
      claim.match(
        /^https:\/\/github\.com\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*?)(?:\.git)?(?:\/|\?|#|$)/i,
      );
    if (match?.[1] && match[2])
      return { owner: match[1].toLowerCase(), repository: match[2].toLowerCase() };
  }
  return undefined;
}

function wellKnownBase(lock: SetupLockMatch): string | undefined {
  if (lock.entry.sourceType !== "well-known") return undefined;
  const candidate = lock.scope === "global" ? lock.entry.sourceBaseUrl : lock.entry.sourceUrl;
  if (!candidate) return undefined;
  const url = URL.parse(candidate);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.hash || url.search)
    return undefined;
  return candidate.replace(/\/$/, "");
}

/** Lock fields identify a candidate coordinate; this performs no upstream observation. */
export function skillsShLockCoordinate(lock: SetupLockMatch): SkitSource | undefined {
  const github = githubRepository(lock);
  if (github && safeSkillPath(lock.entry.skillPath)) return { type: "github", ...github };
  const wellKnown = wellKnownBase(lock);
  if (wellKnown) return { type: "well-known", origin: wellKnown };
  return undefined;
}

export type SkillsShSourceResolution = Data.TaggedEnum<{
  Resolved: { source: SkitSource };
  Unresolvable: {};
  Contested: {};
}>;

export const SkillsShSourceResolution = Data.taggedEnum<SkillsShSourceResolution>();

/** Resolve a claimed coordinate and selected members; this performs no upstream fetch. */
export function resolveSkillsShSelectedSource(
  locks: readonly { lock: SetupLockMatch; name: string }[],
): SkillsShSourceResolution {
  const first = locks[0];
  if (!first) return SkillsShSourceResolution.Unresolvable();
  const coordinate = skillsShLockCoordinate(first.lock);
  if (!coordinate) return SkillsShSourceResolution.Unresolvable();
  for (const { lock } of locks) {
    const candidate = skillsShLockCoordinate(lock);
    if (!candidate) return SkillsShSourceResolution.Unresolvable();
    if (
      !Schema.toEquivalence(SkitSource)(candidate, coordinate) ||
      lock.entry.ref !== first.lock.entry.ref ||
      lock.lockPath !== first.lock.lockPath
    )
      return SkillsShSourceResolution.Contested();
  }
  if (coordinate.type === "well-known") {
    if (locks.some(({ name }) => !namePattern.test(name) || name.length > 64))
      return SkillsShSourceResolution.Unresolvable();
    return SkillsShSourceResolution.Resolved({
      source: { ...coordinate, skillNames: [...new Set(locks.map(({ name }) => name))].sort() },
    });
  }
  if (coordinate.type !== "github") return SkillsShSourceResolution.Unresolvable();
  const paths = locks.flatMap(({ lock }) =>
    safeSkillPath(lock.entry.skillPath) ? [lock.entry.skillPath] : [],
  );
  if (paths.length !== locks.length) return SkillsShSourceResolution.Unresolvable();
  const pathNames = new Map<string, string>();
  const namePaths = new Map<string, string>();
  for (const { lock, name } of locks) {
    const path = lock.entry.skillPath ?? "";
    if (
      (pathNames.has(path) && pathNames.get(path) !== name) ||
      (namePaths.has(name) && namePaths.get(name) !== path)
    )
      return SkillsShSourceResolution.Contested();
    pathNames.set(path, name);
    namePaths.set(name, path);
  }
  return SkillsShSourceResolution.Resolved({
    source: {
      ...coordinate,
      ...(first.lock.entry.ref ? { ref: first.lock.entry.ref } : {}),
      skillDirectories: [...new Set(paths)]
        .sort()
        .map((path) => path.slice(0, -"/SKILL.md".length)),
    },
  });
}

export const setupLockCollection = (
  lock: SetupLockMatch,
): { source: SkitSource; sourceKey: string } | undefined => {
  const source = skillsShLockCoordinate(lock);
  if (!source) return undefined;
  return { source, sourceKey: sourceLocator(source) };
};

export const setupLockGroupKey = (lock: SetupLockMatch) => {
  const collection = setupLockCollection(lock);
  return collection
    ? `${lock.lockPath}\0${collection.sourceKey}\0${lock.entry.ref ?? ""}\0${lock.lockContentHash}`
    : undefined;
};
