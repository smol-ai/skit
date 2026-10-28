import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { Data, Effect, FileSystem, Result, Schema } from "effect";
import { skillsShLockFileEntry, sourceLocator, SkitSource } from "@smolai/skit-core";
import type { MachineId, SkillsShLockFileEntry } from "@smolai/skit-core";
import type {
  SetupLockMatch,
  SetupSkillsLock,
  SetupSkillsLockEntry,
  SetupSkillInstance,
} from "./setup-contract.js";
import { computeSkillsShCompatibleHash } from "./skills-sh-compatible-hash.js";

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

const SkillsLockEntry = Schema.StructWithRest(
  Schema.Struct({
    source: Schema.String,
    sourceType: Schema.String,
    sourceUrl: Schema.optionalKey(Schema.String),
    sourceBaseUrl: Schema.optionalKey(Schema.String),
    ref: Schema.optionalKey(Schema.String),
    updatedAt: Schema.optionalKey(Schema.String),
    skillPath: Schema.optionalKey(Schema.String),
    computedHash: Schema.optionalKey(Schema.String),
    skillFolderHash: Schema.optionalKey(Schema.String),
    wellKnownHash: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const SkillsLockDocument = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Number,
    skills: Schema.Record(Schema.String, SkillsLockEntry),
  }),
);

export const readSkillsLock = Effect.fn("Setup.readSkillsLock")(function* (
  scope: SetupSkillsLock["scope"],
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => undefined));
  if (text === undefined) return undefined;
  const decoded = Schema.decodeUnknownResult(SkillsLockDocument)(text);
  if (Result.isFailure(decoded)) return { scope, path, status: "malformed" as const, entries: [] };
  const expected = scope === "project" ? 1 : 3;
  if (decoded.success.version !== expected)
    return {
      scope,
      path,
      status: "unsupported" as const,
      version: decoded.success.version,
      entries: [] as SetupSkillsLockEntry[],
    };
  const entries: SetupSkillsLockEntry[] = [];
  for (const [name, entry] of Object.entries(decoded.success.skills).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const originalEntry = Schema.decodeUnknownResult(Schema.JsonObject)(entry);
    if (Result.isFailure(originalEntry))
      return { scope, path, status: "malformed" as const, entries: [] };
    entries.push({
      name,
      source: entry.source,
      sourceType: entry.sourceType,
      ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
      ...(entry.sourceBaseUrl ? { sourceBaseUrl: entry.sourceBaseUrl } : {}),
      ...(entry.ref ? { ref: entry.ref } : {}),
      ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
      ...(entry.skillPath ? { skillPath: entry.skillPath } : {}),
      ...(entry.computedHash ? { computedHash: entry.computedHash } : {}),
      ...(entry.skillFolderHash ? { skillFolderHash: entry.skillFolderHash } : {}),
      ...(entry.wellKnownHash ? { wellKnownHash: entry.wellKnownHash } : {}),
      originalEntry: originalEntry.success,
    });
  }
  return {
    scope,
    path,
    status: "valid" as const,
    version: decoded.success.version,
    contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    entries,
  };
});

export const lockMatches = Effect.fn("Setup.lockMatches")(function* (
  hit: { name: string; path: string; realPath: string; repository?: string },
  locks: readonly SetupSkillsLock[],
  includeGlobal: boolean,
) {
  const matches: SetupLockMatch[] = [];
  const names = new Set([hit.name.toLowerCase(), basename(hit.path).toLowerCase()]);
  for (const lock of locks) {
    if (lock.status !== "valid" || lock.version === undefined || lock.contentHash === undefined)
      continue;
    if (lock.scope === "global" && !includeGlobal) continue;
    if (lock.scope === "project" && hit.repository && dirname(lock.path) !== hit.repository)
      continue;
    if (lock.scope === "project" && !hit.repository) continue;
    const entry = lock.entries.find((candidate) => names.has(candidate.name.toLowerCase()));
    if (!entry) continue;
    let content: SetupLockMatch["content"] = "unverifiable";
    const recordedHash = entry.computedHash ?? entry.skillFolderHash;
    if (lock.scope === "project" && recordedHash) {
      const currentHash = yield* computeSkillsShCompatibleHash(hit.realPath, hit.realPath);
      if (currentHash !== undefined) content = currentHash === recordedHash ? "agrees" : "mismatch";
    }
    matches.push({
      scope: lock.scope,
      lockPath: lock.path,
      lockVersion: lock.version,
      lockContentHash: lock.contentHash,
      content,
      entry,
    });
  }
  return matches;
});

export class SkillsShImportEvidenceInvalid extends Schema.TaggedError<SkillsShImportEvidenceInvalid>()(
  "SkillsShImportEvidenceInvalid",
  {
    name: Schema.String,
    reason: Schema.Literals([
      "observation-missing",
      "contested-observation",
      "source-unresolvable",
      "lock-changed",
    ]),
  },
) {}

const lockSkillPath = (lockPath: string | undefined, name: string) => {
  if (!lockPath) return name;
  const normalized = lockPath.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.endsWith("/SKILL.md") ? normalized.slice(0, -"/SKILL.md".length) : normalized;
};

const lockFileEntryFor = (
  lock: SetupLockMatch,
  machineId: MachineId,
  checkedAt: string,
  skillName: string,
): SkillsShLockFileEntry =>
  skillsShLockFileEntry({
    machine_id: machineId,
    read_at: checkedAt,
    ...(lock.entry.updatedAt ? { source_updated_at: lock.entry.updatedAt } : {}),
    lock_path: lock.lockPath,
    lock_version: lock.lockVersion,
    lock_scope: lock.scope,
    lock_content_hash: lock.lockContentHash,
    source: lock.entry.source,
    source_type: lock.entry.sourceType,
    ...(lock.entry.sourceUrl ? { source_url: lock.entry.sourceUrl } : {}),
    ...(lock.entry.sourceBaseUrl ? { source_base_url: lock.entry.sourceBaseUrl } : {}),
    ...(lock.entry.ref ? { ref: lock.entry.ref } : {}),
    skill_name: skillName,
    ...(lock.entry.skillPath ? { skill_path: lock.entry.skillPath } : {}),
    ...(lock.entry.computedHash ? { computed_hash: lock.entry.computedHash } : {}),
    ...(lock.entry.skillFolderHash ? { skill_folder_hash: lock.entry.skillFolderHash } : {}),
    ...(lock.entry.wellKnownHash ? { well_known_hash: lock.entry.wellKnownHash } : {}),
    content_agreement: lock.content,
    original_entry: lock.entry.originalEntry,
  });

/** Revalidate lock claims and prepare evidence for retention, without fetching upstream bytes. */
export const prepareSkillsShImportEvidence = Effect.fn("SkillsShLock.prepareImportEvidence")(
  function* (
    groupKey: string,
    candidates: readonly { name: string; paths: readonly string[]; skillPath?: string }[],
    instances: readonly Pick<SetupSkillInstance, "name" | "path" | "locks" | "contentIdentity">[],
    machineId: MachineId,
    checkedAt: string,
  ) {
    const first = candidates[0];
    if (!first)
      return yield* new SkillsShImportEvidenceInvalid({
        name: "collection",
        reason: "observation-missing",
      });
    const foundSkills = [];
    const provenance = [];
    const claimedMembers: Array<{ lock: SetupLockMatch; name: string }> = [];
    const fs = yield* FileSystem.FileSystem;
    for (const candidate of candidates) {
      const matchingInstances = instances.filter(
        (item) =>
          item.name === candidate.name &&
          candidate.paths.includes(item.path) &&
          item.locks.some((lock) => setupLockGroupKey(lock) === groupKey),
      );
      const matchingClaims = matchingInstances.flatMap((item) =>
        item.locks.filter((lock) => setupLockGroupKey(lock) === groupKey),
      );
      const claimVariants = new Set(
        matchingClaims.map((lock) =>
          [
            lock.entry.sourceType,
            lock.entry.source,
            lock.entry.sourceUrl ?? "",
            lock.entry.sourceBaseUrl ?? "",
            lock.entry.ref ?? "",
            lock.entry.skillPath ?? "",
          ].join("\0"),
        ),
      );
      if (claimVariants.size > 1)
        return yield* new SkillsShImportEvidenceInvalid({
          name: candidate.name,
          reason: "contested-observation",
        });
      const instance = [...matchingInstances].sort((left, right) =>
        left.path.localeCompare(right.path),
      )[0];
      const currentHash = instance?.contentIdentity.currentHash;
      const lock = instance?.locks.find((item) => setupLockGroupKey(item) === groupKey);
      if (!instance || !currentHash || !lock)
        return yield* new SkillsShImportEvidenceInvalid({
          name: candidate.name,
          reason: "observation-missing",
        });
      claimedMembers.push({ lock, name: candidate.name });
      foundSkills.push({
        name: candidate.name,
        sourcePath: instance.path,
        relativePath:
          lock.entry.sourceType === "well-known"
            ? candidate.name
            : lockSkillPath(candidate.skillPath, candidate.name),
        currentHash,
      });
      for (const lockFileEntry of matchingInstances.flatMap((item) =>
        item.locks.filter((candidateLock) => setupLockGroupKey(candidateLock) === groupKey),
      ))
        provenance.push(lockFileEntryFor(lockFileEntry, machineId, checkedAt, candidate.name));
    }
    for (const lock of new Map(claimedMembers.map(({ lock }) => [lock.lockPath, lock])).values()) {
      const text = yield* fs
        .readFileString(lock.lockPath)
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
          ),
        );
      if (`sha256:${createHash("sha256").update(text).digest("hex")}` !== lock.lockContentHash)
        return yield* new SkillsShImportEvidenceInvalid({
          name: first.name,
          reason: "lock-changed",
        });
    }
    const resolution = resolveSkillsShSelectedSource(claimedMembers);
    if (resolution._tag !== "Resolved")
      return yield* new SkillsShImportEvidenceInvalid({
        name: first.name,
        reason: "source-unresolvable",
      });
    const source = resolution.source;
    return { source, skills: foundSkills, lockFileEntries: provenance };
  },
);
