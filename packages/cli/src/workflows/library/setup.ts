import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join, matchesGlob, posix, relative, resolve, sep } from "node:path";
import { Effect, FileSystem, Result, Schema } from "effect";
import {
  canonicalJson,
  Digest,
  LinkStat,
  MachineDocumentJson,
  MachineDocumentV4,
  makeMachineId,
  deterministicTreeHashEffect,
  LibraryStore,
  harnessProfile,
  hashParts,
  observeInventory,
  parseOwnershipMarker,
  parseSkillFrontmatter,
  pathIsWithin,
  readSkitDescriptorEffect,
  resolveHarnessRoot,
  sourceLocator,
  sourceIdentityEquals,
  sourceIdentityFromSource,
  SourceProcess,
  writeJsonAtomicEffect,
  type HarnessName as Harness,
  type LibraryState,
  type MachineId,
  type SkitSource,
  type SkillId,
  type SkillVersionId,
  type SourceIdentity,
  type CurrentMachineDocument,
} from "@smolai/skit-core";
import { probeHarnessesEffect } from "../../harness/probe.js";
import { isErrno } from "../../platform/errno.js";
import { resolveSkillsShSelectedSource, skillsShLockCoordinate } from "./skills-sh-lock-source.js";
import { computeSkillsShCompatibleHash } from "./skills-sh-compatible-hash.js";
import type { InventoryRootOptions } from "../../projection/roots.js";
import type {
  SetupBrokenLink,
  SetupAuthoredCollection,
  SetupGitPreservation,
  SetupLockMatch,
  SetupOnboardingCandidate,
  SetupProjection,
  SetupRepositoryConfig,
  SetupResult,
  SetupSkillInstance,
  SetupSkillsLock,
  SetupSkillsLockEntry,
  SetupSuppressed,
} from "./setup-contract.js";

const HARNESSES = ["codex", "claude-code", "opencode", "devin"] as const;
const MACHINE_CONFIG_FILE = "machine.json";

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

const SkillsLockEntry = Schema.Struct({
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
});

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

const RepositoryRelativeGlob = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))(?!!).+$/),
);
const RepositoryRelativeDirectory = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))[^*?[\]{}!]+$/),
);
const RepositoryConfigHeader = Schema.fromJsonString(Schema.Struct({ schema: Schema.String }));
const RepositoryConfigDocument = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal("skit.config.v1"),
    discovery: Schema.Struct({
      exclude: Schema.Array(RepositoryRelativeGlob),
      collections: Schema.Array(Schema.Struct({ path: RepositoryRelativeDirectory })),
    }),
  }),
);

export class SetupConfigUnusable extends Schema.TaggedError<SetupConfigUnusable>()(
  "SetupConfigUnusable",
  { path: Schema.String },
) {
  get message() {
    return `SKIT machine configuration is invalid: ${this.path}`;
  }
}

export class SetupPlanStale extends Schema.TaggedError<SetupPlanStale>()("SetupPlanStale", {
  approvedPlanId: Digest,
  currentPlanId: Digest,
}) {
  get message() {
    return "The setup plan changed after it was reviewed. Review the current plan before applying.";
  }
}

export interface SetupOptions {
  readonly libraryHome: string;
  readonly repositoryRoots?: readonly string[];
  readonly inventory: InventoryRootOptions;
  readonly persistRoots: boolean;
  readonly probePath?: string;
  readonly skillsStateHome?: string;
  readonly machineDisplayName?: string;
  readonly repositoryDecisions?: readonly {
    readonly path: string;
    readonly status: "watched" | "ignored";
  }[];
  readonly scanDecidedRepositories?: boolean;
}

interface DirectoryEntry {
  readonly name: string;
  readonly info: Effect.Success<ReturnType<LinkStat["Service"]["lstat"]>>;
}

interface SkillHit {
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

const machineConfigPath = (home: string) => join(resolve(home), MACHINE_CONFIG_FILE);

export const setupDiscoveryRoots = (config: CurrentMachineDocument): readonly string[] =>
  config.discoveryRoots;

export const setupRepositoryDecisions = (
  config: CurrentMachineDocument,
): readonly { path: string; status: "watched" | "ignored" }[] => config.repositories;

const sourceIdentityLabel = (source: SourceIdentity): string => {
  switch (source.kind) {
    case "github":
      return `${source.owner}/${source.repository}${source.collection_root === "." ? "" : `/${source.collection_root}`}`;
    case "git":
      return `${source.remote.value}${source.collection_root === "." ? "" : `/${source.collection_root}`}`;
    case "registry":
      return `${source.authority.replace(/\/+$/, "")}/${source.namespace}/${source.slug}`;
    case "url":
    case "archive":
      return source.url.value;
    case "local":
      return source.path.value;
    case "authored-workspace":
      return `authored:${source.workspace_id}`;
    case "well-known":
      return source.locator.value;
  }
};

export const classifyObservedOwner = (input: {
  readonly canonicalPath: string;
  readonly home: string;
  readonly harnesses: readonly Harness[];
  readonly repository?: string;
  readonly locks?: readonly SetupLockMatch[];
}): SetupSkillInstance["owner"] => {
  const agreeingLock = input.locks?.find((lock) => lock.content === "agrees");
  if (agreeingLock) return { kind: "skills-sh", source: agreeingLock.entry.source };
  if (input.repository) return { kind: "repository", repository: input.repository };
  if (input.harnesses.includes("codex")) {
    const codexHome = join(resolve(input.home), ".codex");
    if (pathIsWithin(join(codexHome, "skills", ".system"), input.canonicalPath))
      return { kind: "harness", harness: "codex", source: "Codex system", bundled: true };
    const pluginCache = join(codexHome, "plugins", "cache");
    if (pathIsWithin(join(pluginCache, "openai-bundled"), input.canonicalPath))
      return { kind: "harness", harness: "codex", source: "Codex bundled", bundled: true };
    if (pathIsWithin(join(pluginCache, "openai-primary-runtime"), input.canonicalPath))
      return { kind: "harness", harness: "codex", source: "Codex runtime", bundled: false };
    if (pathIsWithin(join(pluginCache, "openai-curated-remote"), input.canonicalPath))
      return { kind: "harness", harness: "codex", source: "Codex curated", bundled: false };
  }
  return { kind: "unknown" };
};

export const isSetupCandidateSelectedByDefault = (owner: SetupSkillInstance["owner"]): boolean =>
  owner.kind === "unknown";

export const readSetupMachineConfig = Effect.fn("Setup.readMachineConfig")(function* (
  libraryHome: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = machineConfigPath(libraryHome);
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        isErrno(error, "ENOENT")
          ? Effect.succeed(undefined)
          : Effect.fail(new SetupConfigUnusable({ path })),
      ),
    );
  if (text === undefined)
    return {
      path,
      schemaVersion: 4 as const,
      discoveryRoots: [],
      repositories: [],
      repositoryDecisionsInitialized: false,
    };
  return yield* Schema.decodeUnknownEffect(MachineDocumentJson)(text).pipe(
    Effect.mapError(() => new SetupConfigUnusable({ path })),
    Effect.map((config) => ({ path, ...config })),
  );
});

const writeSetupMachineConfig = Effect.fn("Setup.writeMachineConfig")(function* (
  libraryHome: string,
  discoveryRoots: readonly string[],
  repositories: readonly { path: string; status: "watched" | "ignored" }[],
  prior: CurrentMachineDocument,
  displayName: string,
) {
  const path = machineConfigPath(libraryHome);
  const config = yield* MachineDocumentV4.makeEffect({
    schemaVersion: 4,
    machineId: prior.machineId ?? makeMachineId(),
    displayName: prior.displayName ?? displayName,
    discoveryRoots: [...discoveryRoots],
    repositories: [...repositories],
  });
  yield* writeJsonAtomicEffect(path, config);
  return { path, ...config };
});

export const updateSetupRepositoryDecision = Effect.fn("Setup.updateRepositoryDecision")(function* (
  libraryHome: string,
  repository: string,
  status: "watched" | "ignored" | undefined,
) {
  const prior = yield* readSetupMachineConfig(libraryHome);
  const path = resolve(repository);
  const decisions = new Map(
    setupRepositoryDecisions(prior).map((decision) => [resolve(decision.path), decision.status]),
  );
  if (status === undefined) decisions.delete(path);
  else decisions.set(path, status);
  return yield* writeSetupMachineConfig(
    libraryHome,
    setupDiscoveryRoots(prior),
    [...decisions]
      .map(([decisionPath, decisionStatus]) => ({
        path: decisionPath,
        status: decisionStatus,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    prior,
    hostname(),
  );
});

const readRepositoryConfig = Effect.fn("Setup.readRepositoryConfig")(function* (
  repository: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(repository, "skit.config.json");
  const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => undefined));
  if (text === undefined)
    return {
      repository,
      path,
      status: "missing" as const,
      exclude: [] as string[],
      collections: [] as Array<{ path: string }>,
    };
  const header = Schema.decodeUnknownResult(RepositoryConfigHeader)(text);
  if (Result.isFailure(header))
    return {
      repository,
      path,
      status: "malformed" as const,
      exclude: [] as string[],
      collections: [] as Array<{ path: string }>,
    };
  if (header.success.schema !== "skit.config.v1")
    return {
      repository,
      path,
      status: "unsupported" as const,
      schema: header.success.schema,
      exclude: [] as string[],
      collections: [] as Array<{ path: string }>,
    };
  const decoded = Schema.decodeUnknownResult(RepositoryConfigDocument, {
    onExcessProperty: "error",
  })(text);
  if (Result.isFailure(decoded))
    return {
      repository,
      path,
      status: "malformed" as const,
      schema: header.success.schema,
      exclude: [] as string[],
      collections: [] as Array<{ path: string }>,
    };
  return {
    repository,
    path,
    status: "valid" as const,
    schema: decoded.success.schema,
    exclude: [...new Set(decoded.success.discovery.exclude)].sort(),
    collections: [...decoded.success.discovery.collections].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  } satisfies SetupRepositoryConfig;
});

const repositoryPathExcluded = (config: SetupRepositoryConfig | undefined, path: string) => {
  if (config?.status !== "valid") return false;
  const relativePath = path.split(sep).join(posix.sep).replace(/^\.\//, "");
  return config.exclude.some((pattern) => {
    const directory = pattern.replace(/\/+$/, "");
    const literalDirectory = !/[*?[\]{}]/.test(directory);
    return (
      matchesGlob(relativePath, pattern) ||
      (literalDirectory && (relativePath === directory || relativePath.startsWith(`${directory}/`)))
    );
  });
};

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
  const decoded = Schema.decodeUnknownResult(SkillsLockDocument)(text, {
    onExcessProperty: "preserve",
  });
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

export const computeSkillsLockCompatibleHash = computeSkillsShCompatibleHash;

const lockMatches = Effect.fn("Setup.lockMatches")(function* (
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
      const observedHash = yield* computeSkillsLockCompatibleHash(hit.realPath, hit.realPath);
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

const custodyAt = Effect.fn("Setup.custody")(function* (path: string) {
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

const collectHarnessRoots = (inventory: InventoryRootOptions, repositories: readonly string[]) => {
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

const collectBrokenLinks = Effect.fn("Setup.brokenLinks")(function* (
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
      locator: `${remote.namespace}/${remote.skit}`,
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
        sourceIdentityEquals(collection.upstream.source_identity, authoredSource),
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

export const runSetup = Effect.fn("Library.setup")(function* (options: SetupOptions) {
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
        discoveryRoots,
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
  const authoredBySkillPath = new Map(
    authoredCollections.flatMap((collection) =>
      collection.skills.map(
        (skill) =>
          [
            skill.path,
            {
              skitLocator: collection.skitLocator,
              ...(collection.collectionId ? { collectionId: collection.collectionId } : {}),
            },
          ] as const,
      ),
    ),
  );
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
  const libraryCollectionsById = new Map(
    library.collections.map((collection) => [collection.collection_id, collection] as const),
  );
  const librarySkillsByHash = new Map<
    string,
    Array<{
      subjectId: string;
      skillId: SkillId;
      skillVersionId: SkillVersionId;
      name: string;
    }>
  >();
  for (const skill of library.skills) {
    const selected = skill?.versions.find(
      (version) => version.skill_version_id === skill.selected_skill_version_id,
    );
    if (skill === undefined || selected === undefined) continue;
    librarySkillsByHash.set(selected.validation_identity_digest, [
      ...(librarySkillsByHash.get(selected.validation_identity_digest) ?? []),
      {
        subjectId: skill.collection_id ?? skill.skill_id,
        skillId: skill.skill_id,
        skillVersionId: selected.skill_version_id,
        name: skill.name,
      },
    ]);
  }
  const grouped = new Map<string, SkillHit[]>();
  for (const hit of hits) grouped.set(hit.realPath, [...(grouped.get(hit.realPath) ?? []), hit]);
  const instances: SetupSkillInstance[] = [];
  for (const group of grouped.values()) {
    const sorted = [...group].sort((left, right) => left.path.localeCompare(right.path));
    const hit = sorted[0]!;
    const roots = harnessRoots.filter(({ root }) =>
      sorted.some((candidate) => pathIsWithin(root, candidate.path)),
    );
    const harnesses = [...new Set(roots.map((root) => root.harness))].sort();
    const scope = roots.some((root) => root.scope === "global")
      ? ("global" as const)
      : hit.repository
        ? ("project" as const)
        : ("standalone" as const);
    const repositoryHit =
      sorted.find((candidate) => candidate.repository && candidate.git.status !== "unavailable") ??
      sorted.find((candidate) => candidate.repository) ??
      hit;
    const authoredCollection = authoredBySkillPath.get(hit.realPath);
    const hashResult = yield* Effect.result(deterministicTreeHashEffect(hit.realPath));
    const contentIdentity = Result.isFailure(hashResult)
      ? { status: "unhashable" as const, libraryMatches: [] }
      : (() => {
          const libraryMatches = librarySkillsByHash.get(hashResult.success) ?? [];
          return {
            status:
              libraryMatches.length === 0
                ? ("none" as const)
                : libraryMatches.length === 1
                  ? ("exact" as const)
                  : ("ambiguous" as const),
            observedHash: hashResult.success,
            libraryMatches,
          };
        })();
    const observedCustody = yield* custodyAt(hit.realPath);
    const markerProjection = observedCustody.marker
      ? observedLibrary.projections.find(
          (projection) => projection.projection_id === observedCustody.marker?.projection_id,
        )
      : undefined;
    const custodyObservation =
      markerProjection !== undefined &&
      !sorted.some((candidate) => resolve(candidate.path) === resolve(markerProjection.path))
        ? ({ custody: "invalid-marker" } as const)
        : observedCustody;
    const managedMembership = (() => {
      const marker = "marker" in custodyObservation ? custodyObservation.marker : undefined;
      if (!marker) return undefined;
      const skill = library.skills.find((candidate) => candidate.skill_id === marker.skill_id);
      const collection =
        skill === undefined ? undefined : libraryCollectionsById.get(skill.collection_id);
      if (skill === undefined)
        return {
          kind: "missing-from-library" as const,
          projectionId: marker.projection_id,
          skillId: marker.skill_id,
          skillVersionId: marker.skill_version_id,
        };
      return {
        kind: "retained" as const,
        projectionId: marker.projection_id,
        collectionId: skill.collection_id,
        skillId: marker.skill_id,
        skillVersionId: marker.skill_version_id,
        displayName: collection?.label ?? skill.name,
        ...(collection?.upstream
          ? {
              source: sourceIdentityLabel(collection.upstream.source_identity),
            }
          : {}),
      };
    })();
    const instanceLocks = yield* lockMatches(
      repositoryHit,
      locks,
      roots.some((root) => root.scope === "global"),
    );
    const observedOwner = classifyObservedOwner({
      canonicalPath: hit.realPath,
      home: options.inventory.home,
      harnesses,
      repository: repositoryHit.git.repository,
      locks: instanceLocks,
    });
    const owner: SetupSkillInstance["owner"] =
      custodyObservation.custody === "skit-managed" && managedMembership
        ? { kind: "skit", membership: managedMembership }
        : custodyObservation.custody === "invalid-marker"
          ? { kind: "invalid-marker" }
          : authoredCollection
            ? { kind: "authored", ...authoredCollection }
            : observedOwner;
    instances.push({
      name: hit.name,
      path: hit.realPath,
      aliases: [...new Set(sorted.map((candidate) => candidate.path))],
      scope,
      harnesses,
      owner,
      contentIdentity,
      git: repositoryHit.git,
      locks: instanceLocks,
    });
  }
  const probes = (yield* probeHarnessesEffect(undefined, { path: options.probePath })).map(
    (probe) => ({ harness: probe.harnessId, status: probe.status, command: probe.command }),
  );
  const projections: SetupProjection[] = [];
  const fs = yield* FileSystem.FileSystem;
  for (const projection of observedLibrary.projections) {
    const skill = observedLibrary.skills.find(
      (candidate) => candidate.skill_id === projection.skill_id,
    );
    if (skill === undefined) continue;
    const path = projection.path;
    const present = yield* fs.exists(path);
    projections.push({
      collectionId: skill.collection_id,
      collectionDisplayName: libraryCollectionsById.get(skill.collection_id)?.label ?? skill.name,
      skillId: skill.skill_id,
      name: skill.name,
      path,
      harnesses: [projection.harness],
      status: !present ? "missing" : projection.status === "installed" ? "current" : "modified",
    });
  }
  const onboarding = classifySetupOnboarding(instances, {
    library,
    machineId: machineConfig.machineId,
  });
  const sortedInstances = instances.sort((left, right) => left.path.localeCompare(right.path));
  const planId = hashParts([
    canonicalJson({
      candidates: onboarding,
      instances: sortedInstances,
      repositoryConfigs,
    }),
  ]);
  const missingRepositories = !discovering
    ? [...existingDecisions]
        .filter(([path, status]) => status === "watched" && !walk.repositories.includes(path))
        .map(([path]) => path)
        .sort()
    : [];
  return {
    machineConfig: {
      path: machineConfig.path,
      ...(machineConfig.machineId === undefined ? {} : { machineId: machineConfig.machineId }),
      ...(machineConfig.displayName === undefined
        ? {}
        : { displayName: machineConfig.displayName }),
      repositoryRoots: discoveryRoots,
      repositoryDecisions: [...existingDecisions]
        .map(([path, status]) => ({ path, status }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      persisted: options.persistRoots,
    },
    probes,
    scan: {
      complete:
        walk.complete &&
        repositoryScans.every((scan) => scan.complete) &&
        repositoryConfigs.every((config) => ["missing", "valid"].includes(config.status)),
      directoriesExamined: walk.directoriesExamined,
      repositorySearchDepth: 1,
      ...(missingRepositories.length ? { missingRepositories } : {}),
    },
    repositories: walk.repositories.flatMap((repository) => {
      const skills = [
        ...new Set(
          instances
            .filter((instance) => instance.git.repository === repository)
            .map((instance) => instance.name),
        ),
      ].sort();
      return skills.length
        ? [
            {
              path: repository,
              skills,
              status: existingDecisions.get(repository) ?? ("undecided" as const),
            },
          ]
        : [];
    }),
    // Missing config is the normal case, not one diagnostic per repository. Keep the complete
    // internal inventory for planning above, but expose only configured or invalid repositories.
    repositoryConfigs: repositoryConfigs.filter((config) => config.status !== "missing"),
    authoredCollections,
    projections: projections.sort((left, right) =>
      `${left.collectionId}\0${left.skillId}\0${left.path ?? ""}`.localeCompare(
        `${right.collectionId}\0${right.skillId}\0${right.path ?? ""}`,
      ),
    ),
    onboarding: { planId, candidates: onboarding },
    locks: [...locks].sort((left, right) => left.path.localeCompare(right.path)),
    instances: sortedInstances,
    brokenLinks: yield* collectBrokenLinks(harnessRoots),
    suppressed: walk.suppressed,
  } satisfies SetupResult;
});

export const revalidateSetupPlan = Effect.fn("Setup.revalidatePlan")(function* (
  options: SetupOptions,
  approvedPlanId: typeof Digest.Type,
) {
  const current = yield* runSetup({ ...options, persistRoots: false });
  if (current.onboarding.planId !== approvedPlanId)
    return yield* Effect.fail(
      new SetupPlanStale({ approvedPlanId, currentPlanId: current.onboarding.planId }),
    );
  return current;
});

export const classifySetupOnboarding = (
  instances: ReadonlyArray<SetupSkillInstance>,
  retained?: {
    library?: LibraryState;
    machineId?: MachineId;
  },
): SetupOnboardingCandidate[] => {
  const libraryCollectionsById = new Map(
    (retained?.library?.collections ?? []).map(
      (collection) => [collection.collection_id, collection] as const,
    ),
  );
  const libraryCollectionSourcesById = new Map(
    (retained?.library?.collections ?? []).flatMap((collection) =>
      collection.upstream
        ? [[collection.collection_id, collection.upstream.source_identity] as const]
        : [],
    ),
  );
  const retainedByLockEvidence = new Map<
    string,
    Array<{ subjectId: string; validationIdentityDigest: string }>
  >();
  if (retained?.library && retained.machineId) {
    const evidenceKeysByAcquisition = new Map<string, string[]>();
    for (const acquisition of retained.library.acquisitions) {
      const keys = acquisition.observations
        .filter((observation) => observation.machine_id === retained.machineId)
        .map((observation) =>
          [
            observation.lock_path.value,
            observation.lock_content_hash,
            observation.skill_name,
            observation.skill_path ?? "",
          ].join("\0"),
        );
      if (keys.length) evidenceKeysByAcquisition.set(acquisition.acquisition_id, keys);
    }
    for (const skill of retained.library.skills)
      for (const version of skill.versions)
        for (const origin of version.origins)
          for (const key of evidenceKeysByAcquisition.get(origin.acquisition_id) ?? [])
            retainedByLockEvidence.set(key, [
              ...(retainedByLockEvidence.get(key) ?? []),
              {
                subjectId: skill.collection_id ?? skill.skill_id,
                validationIdentityDigest: version.validation_identity_digest,
              },
            ]);
  }
  const groups = new Map<string, SetupSkillInstance[]>();
  for (const instance of instances) {
    if (instance.owner.kind === "skit" || instance.owner.kind === "authored") continue;
    const custodyScope = instance.git.repository
      ? `repository:${instance.git.repository}`
      : instance.scope === "global"
        ? "global"
        : `standalone:${instance.path}`;
    const key = `${custodyScope}\0${instance.name}`;
    groups.set(key, [...(groups.get(key) ?? []), instance]);
  }
  const candidates: SetupOnboardingCandidate[] = [];
  for (const group of groups.values()) {
    const name = group[0]!.name;
    const paths = group.map((instance) => instance.path).sort();
    const owner = group[0]!.owner;
    const base = { name, paths, owner };
    if (group.some((instance) => instance.owner.kind === "invalid-marker")) {
      candidates.push({
        ...base,
        action: "blocked",
        reason: "invalid-ownership-marker",
      });
      continue;
    }
    if (owner.kind === "harness") {
      candidates.push({
        ...base,
        action: "harness-owned",
      });
      continue;
    }
    const hashes = new Set(
      group.flatMap((instance) =>
        instance.contentIdentity.observedHash ? [instance.contentIdentity.observedHash] : [],
      ),
    );
    if (hashes.size > 1) {
      candidates.push({
        ...base,
        action: "blocked",
        reason: "divergent-copies",
      });
      continue;
    }
    const groupLocks = group.flatMap((instance) => instance.locks);
    const importableLocks = [
      ...new Map(
        groupLocks.flatMap((lock) => {
          const groupKey = setupLockGroupKey(lock);
          return groupKey ? [[groupKey, lock] as const] : [];
        }),
      ).entries(),
    ];
    if (hashes.size === 1 && importableLocks.length) {
      let offeredImport = false;
      let contestedLockClaim = false;
      let alreadyRetainedGroup = false;
      for (const [groupKey, lock] of importableLocks) {
        const observedInstances = group.filter((instance) =>
          instance.locks.some((candidate) => setupLockGroupKey(candidate) === groupKey),
        );
        const allGroupInstances = instances.filter((instance) =>
          instance.locks.some((candidate) => setupLockGroupKey(candidate) === groupKey),
        );
        const sourceResolution = resolveSkillsShSelectedSource(
          allGroupInstances.flatMap((instance) =>
            instance.locks
              .filter((candidate) => setupLockGroupKey(candidate) === groupKey)
              .map((candidate) => ({ lock: candidate, name: instance.name })),
          ),
        );
        if (sourceResolution._tag !== "Resolved") {
          if (sourceResolution._tag === "Contested") contestedLockClaim = true;
          continue;
        }
        const observedPaths = observedInstances.map((instance) => instance.path).sort();
        let matchingCollections: Set<string> | undefined;
        for (const instance of observedInstances) {
          const observedHash = instance.contentIdentity.observedHash;
          const matchingLock = instance.locks.find((item) => setupLockGroupKey(item) === groupKey);
          if (observedHash === undefined || matchingLock === undefined) {
            matchingCollections = new Set();
            break;
          }
          const evidenceKey = [
            matchingLock.lockPath,
            matchingLock.lockContentHash,
            instance.name,
            matchingLock.entry.skillPath ?? "",
          ].join("\0");
          const collections = new Set(
            (retainedByLockEvidence.get(evidenceKey) ?? [])
              .filter((evidence) => evidence.validationIdentityDigest === observedHash)
              .map((evidence) => evidence.subjectId),
          );
          matchingCollections =
            matchingCollections === undefined
              ? collections
              : new Set(
                  [...matchingCollections].filter((collection) => collections.has(collection)),
                );
        }
        const alreadyRetained = (matchingCollections?.size ?? 0) > 0;
        if (alreadyRetained) {
          alreadyRetainedGroup = true;
          continue;
        }
        candidates.push({
          ...base,
          paths: observedPaths,
          action: "import-observed-collection",
          groupKey,
          source: lock.entry.source,
          lockContentHash: lock.lockContentHash,
          contentAgreement: lock.content,
          ...(lock.entry.skillPath ? { skillPath: lock.entry.skillPath } : {}),
        });
        offeredImport = true;
      }
      if (offeredImport) continue;
      if (alreadyRetainedGroup) continue;
      if (contestedLockClaim) {
        candidates.push({ ...base, action: "blocked", reason: "contested-lock-claim" });
        continue;
      }
    }
    const matches = group.flatMap((instance) => instance.contentIdentity.libraryMatches);
    const uniqueMatches = [
      ...new Map(
        matches.map((match) => [`${match.subjectId}\0${match.skillVersionId}`, match]),
      ).values(),
    ];
    if (
      uniqueMatches.length > 1 ||
      group.some((instance) => instance.contentIdentity.status === "ambiguous")
    ) {
      candidates.push({
        ...base,
        action: "blocked",
        reason: "ambiguous-library-match",
      });
      continue;
    }
    if (uniqueMatches.length === 1) {
      const match = uniqueMatches[0]!;
      if (match.name !== name) {
        candidates.push({
          ...base,
          action: "blocked",
          reason: "library-skill-name-mismatch",
        });
        continue;
      }
      if (group.some((instance) => instance.git.repository !== undefined)) {
        if (
          importableLocks.some(([, lock]) => {
            const source = setupLockCollection(lock)?.source;
            const retainedSkill = retained?.library?.skills.find(
              (skill) =>
                skill.skill_id === match.subjectId || skill.collection_id === match.subjectId,
            );
            const retainedSource =
              retainedSkill === undefined
                ? undefined
                : libraryCollectionSourcesById.get(retainedSkill.collection_id);
            if (source === undefined || retainedSource === undefined) return false;
            const lockSource = sourceIdentityFromSource(source, retained?.machineId);
            return lockSource !== undefined && sourceIdentityEquals(lockSource, retainedSource);
          })
        )
          continue;
        candidates.push({
          ...base,
          action: "repository-owned",
        });
        continue;
      }
      candidates.push({
        ...base,
        action: "bind-existing-entry",
        subjectId: match.subjectId,
        skillVersionId: match.skillVersionId,
        ...(() => {
          const matchedSkill = retained?.library?.skills.find(
            (skill) =>
              skill.skill_id === match.subjectId || skill.collection_id === match.subjectId,
          );
          const label =
            matchedSkill === undefined
              ? undefined
              : libraryCollectionsById.get(matchedSkill.collection_id)?.label;
          return label === undefined ? {} : { collectionDisplayName: label };
        })(),
      });
      continue;
    }
    if (group.some((instance) => instance.git.repository !== undefined)) {
      candidates.push({
        ...base,
        action: "repository-owned",
      });
      continue;
    }
    if (group.some((instance) => instance.contentIdentity.status === "unhashable")) {
      candidates.push({
        ...base,
        action: "blocked",
        reason: "content-unhashable",
      });
      continue;
    }
    const projectionTargets = group.filter(
      (instance) => instance.scope === "global" && instance.harnesses.length > 0,
    );
    if (projectionTargets.length === group.length && hashes.size === 1) {
      candidates.push({
        ...base,
        action: "manage-locally",
        ...(paths.length === 1
          ? { sourceSelection: "automatic" as const, sourcePath: paths[0]! }
          : { sourceSelection: "required" as const }),
      });
      continue;
    }
    candidates.push({
      ...base,
      action: "leave-alone",
    });
  }
  return candidates.sort((left, right) =>
    `${left.name}\0${left.paths[0] ?? ""}`.localeCompare(`${right.name}\0${right.paths[0] ?? ""}`),
  );
};
