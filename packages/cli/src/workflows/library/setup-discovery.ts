import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { Effect, FileSystem, Result, Schema } from "effect";
import {
  LinkStat,
  LibraryStore,
  harnessProfile,
  observeInventory,
  parseOwnershipMarker,
  parseSkillFrontmatter,
  pathIsWithin,
  readSkitDescriptorEffect,
  resolveHarnessRoot,
  sourceLocator,
  SourceIdentity,
  SourceProcess,
  type HarnessName as Harness,
  type LibraryState,
} from "@smolai/skit-core";
import { computeSkillsShCompatibleHash } from "./skills-sh-compatible-hash.js";
import type { InventoryRootOptions } from "../../projection/roots.js";
import {
  readSetupMachineConfig,
  writeSetupMachineConfig,
  setupDiscoveryRoots,
  setupRepositoryDecisions,
  readRepositoryConfig,
  repositoryPathExcluded,
} from "./setup-config.js";
import type { SetupOptions } from "./setup.js";
import type {
  SetupBrokenLink,
  SetupAuthoredCollection,
  SetupGitPreservation,
  SetupLockMatch,
  SetupRepositoryConfig,
  SetupSkillsLock,
  SetupSkillsLockEntry,
  SetupSuppressed,
} from "./setup-contract.js";
const HARNESSES = ["codex", "claude-code", "opencode", "devin"] as const;
const SUPPRESSED_NAMES = new Map<string, SetupSuppressed["reason"]>([
  ["node_modules", "dependency"],
  [".venv", "dependency"],
  ["vendor", "dependency"],
  ["dist", "build"],
  ["build", "build"],
  ["out", "build"],
  ["target", "build"],
  ["coverage", "build"],
  [".tmp", "cache"],
  [".runs", "generated"],
  [".skit", "skit-state"],
  [".git", "skit-state"],
]);

const HARNESS_DOT_DIRS = new Set([
  ".claude",
  ".agents",
  ".codex",
  ".opencode",
  ".devin",
  ".cognition",
  ".github",
  ".cursor",
  ".windsurf",
]);
const PROJECT_COLLECTION_ROOTS = [
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
] as const;

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
    wellKnownDigest: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const SkillsLockDocument = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Number,
    skills: Schema.Record(Schema.String, SkillsLockEntry),
  }),
);

const AuthorRemoteDocument = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal("skit.remote.v1"),
    origin: Schema.String,
    namespace: Schema.String,
    skit: Schema.String,
  }),
);

interface DirectoryEntry {
  readonly name: string;
  readonly info: Effect.Success<ReturnType<LinkStat["Service"]["lstat"]>>;
}

export interface SkillHit {
  readonly path: string;
  readonly realPath: string;
  readonly name: string;
  readonly repository?: string;
  readonly git: SetupGitPreservation;
}

interface WalkResult {
  readonly directories: readonly string[];
  readonly repositories: readonly string[];
  readonly suppressed: readonly SetupSuppressed[];
  readonly complete: boolean;
  readonly directoriesExamined: number;
}

const entriesOf = Effect.fn("Setup.entries")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as string[]));
  return yield* Effect.forEach(names, (name) =>
    links.lstat(join(directory, name)).pipe(
      Effect.map((info) => ({ name, info }) satisfies DirectoryEntry),
      Effect.orElseSucceed(() => undefined),
    ),
  ).pipe(Effect.map((entries) => entries.filter((entry) => entry !== undefined)));
});

const walkRepositoryRoots = Effect.fn("Setup.walkRepositoryRoots")(function* (
  roots: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const visited = new Set<string>();
  const directories: string[] = [];
  const repositories = new Set<string>();
  const suppressed = new Map<string, SetupSuppressed>();
  const examine = Effect.fn("Setup.examineRepositoryCandidate")(function* (directory: string) {
    if (!visited.has(directory)) {
      visited.add(directory);
      directories.push(directory);
    }
    if (yield* fs.exists(join(directory, ".git"))) {
      repositories.add(directory);
      return true;
    }
    return false;
  });
  for (const configuredRoot of roots) {
    const root = resolve(configuredRoot);
    if (yield* examine(root)) continue;
    for (const entry of yield* entriesOf(root)) {
      if (entry.info.type !== "Directory") continue;
      const child = join(root, entry.name);
      const reason = SUPPRESSED_NAMES.get(entry.name);
      if (reason) {
        suppressed.set(child, { path: child, reason });
        continue;
      }
      if (entry.name.startsWith(".") && !HARNESS_DOT_DIRS.has(entry.name)) {
        suppressed.set(child, { path: child, reason: "cache" });
        continue;
      }
      yield* examine(child);
    }
  }
  return {
    directories,
    repositories: [...repositories].sort(),
    suppressed: [...suppressed.values()].sort((left, right) => left.path.localeCompare(right.path)),
    complete: true,
    directoriesExamined: visited.size,
  } satisfies WalkResult;
});

const inspectWatchedRepositories = Effect.fn("Setup.inspectWatchedRepositories")(function* (
  repositories: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const present: string[] = [];
  let complete = true;
  for (const repository of repositories.map((path) => resolve(path)).sort()) {
    if ((yield* fs.exists(repository)) && (yield* fs.exists(join(repository, ".git"))))
      present.push(repository);
    else complete = false;
  }
  return {
    directories: [...present],
    repositories: present,
    suppressed: [] as SetupSuppressed[],
    complete,
    directoriesExamined: repositories.length,
  } satisfies WalkResult;
});

const nearestRepository = (path: string, repositories: readonly string[]) =>
  repositories
    .filter((repository) => pathIsWithin(repository, path))
    .sort((left, right) => right.length - left.length)[0];

function overrideRoots(
  harness: Harness,
  options: InventoryRootOptions,
): readonly string[] | undefined {
  if (harness === "codex")
    return options.overrides.codex ? [resolve(options.overrides.codex)] : undefined;
  if (harness === "claude-code")
    return options.overrides.claude ? [resolve(options.overrides.claude)] : undefined;
  if (harness === "opencode")
    return options.overrides.opencode ? [resolve(options.overrides.opencode)] : undefined;
  return options.overrides.devin?.length
    ? options.overrides.devin.map((root) => resolve(root))
    : undefined;
}

function catalogRoots(
  harness: Harness,
  scope: "global" | "project",
  context: { home: string; configHome: string; repository?: string },
): string[] {
  if (scope === "project" && !context.repository) return [];
  return harnessProfile(harness)
    .roots.filter((root) => root.scope === scope && root.readable)
    .map((root) => resolveHarnessRoot(root, context));
}

const skillNameAt = Effect.fn("Setup.skillName")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(join(directory, "SKILL.md"))
    .pipe(Effect.orElseSucceed(() => ""));
  const fields = parseSkillFrontmatter(text);
  return typeof fields?.name === "string" && fields.name ? fields.name : basename(directory);
});

const realPathOf = Effect.fn("Setup.realPath")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => resolve(path)));
});

const collectSkillHits = Effect.fn("Setup.collectSkillHits")(function* (
  directories: readonly string[],
  repositories: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const hits: SkillHit[] = [];
  for (const directory of directories) {
    const document = join(directory, "SKILL.md");
    if (!(yield* fs.exists(document))) continue;
    const info = yield* fs.stat(document).pipe(Effect.orElseSucceed(() => undefined));
    if (info?.type !== "File") continue;
    const repository = nearestRepository(directory, repositories);
    hits.push({
      path: directory,
      realPath: yield* realPathOf(directory),
      name: yield* skillNameAt(directory),
      ...(repository ? { repository } : {}),
      git: repository ? { status: "unavailable", repository } : { status: "outside-git" },
    });
  }
  return hits;
});

const commandOutput = Effect.fn("Setup.commandOutput")(function* (args: readonly string[]) {
  const process = yield* SourceProcess;
  return yield* Effect.result(
    process.output("git", args).pipe(
      Effect.mapError(() => -1),
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(new TextDecoder().decode(result.stdout))
          : Effect.fail(result.exitCode),
      ),
    ),
  );
});

const gitPaths = (output: string) => output.split("\0").filter(Boolean);

const suppressedGitDocument = (document: string) =>
  document
    .split(posix.sep)
    .slice(0, -1)
    .some((segment) => SUPPRESSED_NAMES.has(segment));

const gitStatusRecords = (output: string) => {
  const fields = output.split("\0");
  const records: Array<{ code: string; path: string }> = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    const code = field.slice(0, 2);
    records.push({ code, path: field.slice(3).replace(/\/$/, "") });
    if (code.includes("R") || code.includes("C")) index++;
  }
  return records;
};

const preservationStatus = (
  repository: string,
  directory: string,
  tracked: ReadonlySet<string>,
  changed: readonly { code: string; path: string }[],
): SetupGitPreservation => {
  const document = posix.join(directory, "SKILL.md");
  const codes = changed
    .filter(
      (record) =>
        directory === "." ||
        record.path === directory ||
        record.path.startsWith(`${directory}/`) ||
        (record.code === "!!" && directory.startsWith(`${record.path.replace(/\/$/, "")}/`)),
    )
    .map((record) => record.code);
  const hasTracked = tracked.has(document);
  const ignored = codes.some((code) => code === "!!");
  const untracked = codes.some((code) => code === "??");
  const staged = codes.some((code) => ![" ", "?", "!"].includes(code[0] ?? " "));
  const modified = codes.some((code) => ![" ", "?", "!"].includes(code[1] ?? " "));
  const kinds = [hasTracked, ignored, untracked, staged, modified].filter(Boolean).length;
  const status: SetupGitPreservation["status"] =
    kinds > 1 && (ignored || untracked)
      ? "mixed"
      : staged
        ? "staged"
        : modified
          ? "modified"
          : ignored
            ? "ignored"
            : untracked
              ? "untracked"
              : "committed";
  return { status, repository };
};

const collectRepositorySkillHits = Effect.fn("Setup.collectRepositorySkillHits")(function* (
  repository: string,
  localCandidates: readonly string[],
  config: SetupRepositoryConfig | undefined,
) {
  const pathspecs = [
    ":(glob)**/SKILL.md",
    ...[...SUPPRESSED_NAMES.keys()].map((name) => `:(exclude,glob)**/${name}/**`),
  ];
  const trackedResult = yield* commandOutput([
    "-C",
    repository,
    "ls-files",
    "-z",
    "--cached",
    "--",
    ...pathspecs,
  ]);
  if (Result.isFailure(trackedResult)) return { hits: [] as SkillHit[], complete: false };
  const tracked = new Set(gitPaths(trackedResult.success));
  const localDocuments = localCandidates.map((path) =>
    posix.join(relative(repository, path).split(sep).join(posix.sep), "SKILL.md"),
  );
  const documents = [...new Set([...tracked, ...localDocuments])]
    .filter((document) => !suppressedGitDocument(document))
    .filter((document) => !repositoryPathExcluded(config, document))
    .sort();
  const directories = documents.map((document) => posix.dirname(document));
  const statusResult = directories.length
    ? yield* commandOutput([
        "-C",
        repository,
        "status",
        "--porcelain=v1",
        "-z",
        "--ignored=matching",
        "--untracked-files=all",
        "--",
        ...directories,
      ])
    : Result.succeed("");
  const changed = Result.isSuccess(statusResult) ? gitStatusRecords(statusResult.success) : [];
  const fs = yield* FileSystem.FileSystem;
  const hits: SkillHit[] = [];
  for (const document of documents) {
    const path = join(repository, posix.dirname(document));
    if (!(yield* fs.exists(join(path, "SKILL.md")))) continue;
    hits.push({
      path,
      realPath: yield* realPathOf(path),
      name: yield* skillNameAt(path),
      repository,
      git: Result.isSuccess(statusResult)
        ? preservationStatus(repository, posix.dirname(document), tracked, changed)
        : { status: "unavailable", repository },
    });
  }
  return { hits, complete: Result.isSuccess(statusResult) };
});

const readSkillsLock = Effect.fn("Setup.readSkillsLock")(function* (
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
      ...(entry.wellKnownDigest ? { wellKnownDigest: entry.wellKnownDigest } : {}),
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
  hit: SkillHit,
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
      const observedHash = yield* computeSkillsShCompatibleHash(hit.realPath, hit.realPath);
      if (observedHash !== undefined)
        content = observedHash === recordedHash ? "agrees" : "mismatch";
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

export const custodyAt = Effect.fn("Setup.custody")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const marker = yield* fs
    .readFileString(join(path, ".skit-ownership.json"))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (marker === undefined) return { custody: "unmanaged" as const };
  const document = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))(marker);
  if (Result.isFailure(document)) return { custody: "invalid-marker" as const };
  const inspection = parseOwnershipMarker(document.success);
  return inspection.kind === "valid"
    ? { custody: "skit-managed" as const, marker: inspection.marker }
    : { custody: "invalid-marker" as const };
});

export const collectHarnessRoots = (
  inventory: InventoryRootOptions,
  repositories: readonly string[],
) => {
  const roots: Array<{ harness: Harness; scope: "global" | "project"; root: string }> = [];
  for (const harness of HARNESSES) {
    const global =
      overrideRoots(harness, inventory) ??
      catalogRoots(harness, "global", {
        home: inventory.home,
        configHome: inventory.configHome,
      });
    for (const root of global) roots.push({ harness, scope: "global", root });
    for (const repository of repositories)
      for (const root of catalogRoots(harness, "project", {
        home: inventory.home,
        configHome: inventory.configHome,
        repository,
      }))
        roots.push({ harness, scope: "project", root });
  }
  return roots;
};

export const collectBrokenLinks = Effect.fn("Setup.brokenLinks")(function* (
  roots: readonly { harness: Harness; root: string }[],
) {
  const fs = yield* FileSystem.FileSystem;
  const byPath = new Map<string, SetupBrokenLink>();
  for (const { harness, root } of roots) {
    for (const entry of yield* entriesOf(root)) {
      if (entry.info.type !== "SymbolicLink") continue;
      const path = join(root, entry.name);
      if (yield* fs.exists(path)) continue;
      const target = yield* fs.readLink(path).pipe(Effect.orElseSucceed(() => ""));
      const prior = byPath.get(path);
      byPath.set(path, {
        path,
        target,
        harnesses: [...new Set([...(prior?.harnesses ?? []), harness])].sort(),
      });
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
});

const collectAuthoredCollections = Effect.fn("Setup.authoredCollections")(function* (
  repositories: readonly string[],
  library: LibraryState,
) {
  const fs = yield* FileSystem.FileSystem;
  const collections: SetupAuthoredCollection[] = [];
  for (const repository of repositories) {
    const descriptorPath = join(repository, "skit.json");
    const remotePath = join(repository, "skit.remote.json");
    if (!(yield* fs.exists(descriptorPath)) || !(yield* fs.exists(remotePath))) continue;
    const descriptor = yield* readSkitDescriptorEffect(repository).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const remote = yield* fs.readFileString(remotePath).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(AuthorRemoteDocument, { onExcessProperty: "error" }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    if (!descriptor || !remote || descriptor.slug !== remote.skit) continue;
    const skitLocator = sourceLocator({
      type: "registry",
      namespace: remote.namespace,
      slug: remote.skit,
      authority: remote.origin,
    });
    const authoredSource: SourceIdentity = {
      kind: "registry",
      authority: remote.origin,
      namespace: remote.namespace,
      slug: remote.skit,
    };
    const collectionId = library.collections.find(
      (collection) =>
        collection.upstream !== undefined &&
        Schema.toEquivalence(SourceIdentity)(collection.upstream.source_identity, authoredSource),
    )?.collection_id;
    const skills = yield* Effect.forEach(descriptor.skills, (skill) => {
      const path = resolve(repository, skill.path);
      return fs.realPath(path).pipe(
        Effect.map((realPath) => ({ name: skill.name, path: realPath })),
        Effect.orElseSucceed(() => ({ name: skill.name, path })),
      );
    });
    collections.push({
      repository,
      descriptorPath,
      remotePath,
      skitLocator,
      origin: remote.origin,
      namespace: remote.namespace,
      skit: remote.skit,
      ...(collectionId ? { collectionId } : {}),
      skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }
  return collections.sort((left, right) => left.repository.localeCompare(right.repository));
});

export const collectSetupEvidence = Effect.fn("Setup.collectEvidence")(function* (
  options: SetupOptions,
) {
  const prior = yield* readSetupMachineConfig(options.libraryHome);
  const discoveryRoots = [
    ...new Set(
      (options.repositoryRoots ?? setupDiscoveryRoots(prior)).map((path) => resolve(path)),
    ),
  ].sort();
  const existingDecisions = new Map(
    setupRepositoryDecisions(prior).map((decision) => [resolve(decision.path), decision.status]),
  );
  for (const decision of options.repositoryDecisions ?? [])
    existingDecisions.set(resolve(decision.path), decision.status);
  const discovering =
    !options.scanDecidedRepositories ||
    (!prior.repositoryDecisionsInitialized && existingDecisions.size === 0);
  const walk = discovering
    ? yield* walkRepositoryRoots(discoveryRoots)
    : yield* inspectWatchedRepositories(
        [...existingDecisions].filter(([, status]) => status === "watched").map(([path]) => path),
      );
  const machineConfig = options.persistRoots
    ? yield* writeSetupMachineConfig(
        options.libraryHome,
        // Setup never clears saved discovery roots; an empty list only narrows this scan.
        discoveryRoots.length ? discoveryRoots : setupDiscoveryRoots(prior),
        [...existingDecisions]
          .map(([path, status]) => ({ path, status }))
          .sort((left, right) => left.path.localeCompare(right.path)),
        prior,
        options.machineDisplayName ?? hostname(),
      )
    : prior;
  const repositoryConfigs = yield* Effect.forEach(walk.repositories, readRepositoryConfig);
  const repositoryConfigByPath = new Map(
    repositoryConfigs.map((config) => [config.repository, config] as const),
  );
  const harnessRoots = collectHarnessRoots(options.inventory, walk.repositories);
  const library = yield* (yield* LibraryStore).load;
  const authoredCollections = yield* collectAuthoredCollections(walk.repositories, library);
  const observedLibrary = yield* observeInventory(
    library,
    harnessRoots.map(({ harness, root }) => ({ harness, root })),
  );
  const harnessSkillDirectories: string[] = [];
  for (const { root } of harnessRoots)
    for (const entry of yield* entriesOf(root))
      if (entry.info.type === "Directory" || entry.info.type === "SymbolicLink")
        harnessSkillDirectories.push(join(root, entry.name));
  for (const repository of walk.repositories) harnessSkillDirectories.push(repository);
  for (const repository of walk.repositories)
    for (const collectionRoot of [
      ...PROJECT_COLLECTION_ROOTS,
      ...(repositoryConfigByPath.get(repository)?.collections.map((entry) => entry.path) ?? []),
    ]) {
      const root = join(repository, ...collectionRoot.split("/"));
      for (const entry of yield* entriesOf(root))
        if (entry.info.type === "Directory" || entry.info.type === "SymbolicLink")
          harnessSkillDirectories.push(join(root, entry.name));
    }
  const filesystemDirectories = walk.directories.filter(
    (directory) => nearestRepository(directory, walk.repositories) === undefined,
  );
  const filesystemHits = yield* collectSkillHits(
    [...new Set([...filesystemDirectories, ...harnessSkillDirectories])],
    walk.repositories,
  ).pipe(
    Effect.map((hits) =>
      hits.filter(
        (hit) =>
          !hit.repository ||
          !repositoryPathExcluded(
            repositoryConfigByPath.get(hit.repository),
            relative(hit.repository, hit.path),
          ),
      ),
    ),
  );
  const repositoryScans = yield* Effect.forEach(
    walk.repositories,
    (repository) =>
      collectRepositorySkillHits(
        repository,
        filesystemHits.filter((hit) => hit.repository === repository).map((hit) => hit.path),
        repositoryConfigByPath.get(repository),
      ),
    { concurrency: 8 },
  );
  const hits = [...filesystemHits, ...repositoryScans.flatMap((scan) => scan.hits)];
  const globalLockPath = options.skillsStateHome
    ? join(resolve(options.skillsStateHome), "skills", ".skill-lock.json")
    : join(resolve(options.inventory.home), ".agents", ".skill-lock.json");
  const lockCandidates = [
    yield* readSkillsLock("global", globalLockPath),
    ...(yield* Effect.forEach(walk.repositories, (repository) =>
      readSkillsLock("project", join(repository, "skills-lock.json")),
    )),
  ];
  const locks = lockCandidates.filter((lock) => lock !== undefined);
  return {
    machineConfig,
    discoveryRoots,
    existingDecisions,
    discovering,
    walk,
    repositoryConfigs,
    harnessRoots,
    library,
    authoredCollections,
    observedLibrary,
    repositoryScans,
    hits,
    locks,
  };
});

export type SetupEvidence = Effect.Success<ReturnType<typeof collectSetupEvidence>>;
