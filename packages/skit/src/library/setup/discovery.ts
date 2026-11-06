import * as Library from "../library.js";
import { basename, join, posix, relative, resolve, sep } from "node:path";
import { Effect, FileSystem, Result, Schema } from "effect";
import { LinkStat } from "../../platform/link-stat.js";
import { emptyLibraryState, type LibraryState } from "../library-state.js";
import { inspectOwnershipMarker } from "../../installed-skills/marker-inspection.js";
import { scanInventory } from "../inventory/refresh.js";
import { parseSkillFrontmatter } from "../../harnesses/frontmatter.js";
import { pathIsWithin } from "../../platform/path-identity.js";
import { readSkitDescriptor } from "../../artifact/skit.js";
import { sourceLocator } from "../../sources/resolve.js";
import { SourceIdentity } from "../library-contracts.js";
import { SourceProcess } from "../../platform/source-process.js";
import { HarnessName, type HarnessName as Harness } from "../../harnesses/contracts.js";
import * as MachineSettings from "../machine-settings.js";
import { readSkillsLock } from "./skills-sh/lock-source.js";
import { readableSkillsDirectories } from "../routing/duplicates.js";
import { type InventoryRootOptions } from "../routing/roots.js";
import { readRepositoryConfig, repositoryPathExcluded } from "./config.js";
import type { SetupOptions } from "./scan.js";
import type {
  SetupBrokenLink,
  SetupAuthoredCollection,
  SetupGitStatus,
  SetupRepositoryConfig,
  SetupSuppressed,
  SetupScanIssue,
} from "./contract.js";
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
  readonly git: SetupGitStatus;
}

interface WalkResult {
  readonly directories: readonly string[];
  readonly repositories: readonly string[];
  readonly suppressed: readonly SetupSuppressed[];
  readonly complete: boolean;
  readonly issues: readonly SetupScanIssue[];
  readonly directoriesExamined: number;
}

// Only expected filesystem gaps are observations. Other errors and defects stay failures.
const entriesOf = Effect.fn("Setup.entries")(function* (directory: string, optional = false) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const entries: DirectoryEntry[] = [];
  const issues: SetupScanIssue[] = [];
  const listing = yield* Effect.result(fs.readDirectory(directory));
  if (Result.isFailure(listing)) {
    const reason = listing.failure.reason._tag;
    if (reason === "NotFound") {
      if (!optional) issues.push({ path: directory, code: "MISSING_ROOT" });
    } else if (reason === "PermissionDenied")
      issues.push({ path: directory, code: "UNREADABLE_PATH" });
    else return yield* Effect.fail(listing.failure);
  } else {
    for (const name of listing.success.sort()) {
      const path = join(directory, name);
      const observed = yield* Effect.result(links.lstat(path));
      if (Result.isSuccess(observed)) entries.push({ name, info: observed.success });
      else if (observed.failure.reason._tag === "NotFound")
        issues.push({ path, code: "MISSING_PATH" });
      else if (observed.failure.reason._tag === "PermissionDenied")
        issues.push({ path, code: "UNREADABLE_PATH" });
      else return yield* Effect.fail(observed.failure);
    }
  }
  return { entries, issues, complete: issues.length === 0 };
});

const repositoryMarker = Effect.fn("Setup.repositoryMarker")(function* (
  directory: string,
  issues: SetupScanIssue[],
  required = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(directory, ".git");
  const marker = yield* Effect.result(fs.stat(path));
  if (Result.isSuccess(marker)) return true;
  if (marker.failure.reason._tag === "NotFound") {
    if (required) issues.push({ path, code: "MISSING_ROOT" });
  } else if (marker.failure.reason._tag === "PermissionDenied")
    issues.push({ path, code: "UNREADABLE_PATH" });
  else return yield* Effect.fail(marker.failure);
  return false;
});

/** Folders people commonly keep their repositories in, relative to their home. */
const commonRepositoryFolders = [
  "Work",
  "work",
  "dev",
  "Developer",
  "code",
  "Code",
  "src",
  "projects",
  "Projects",
  "repos",
  "git",
];

/**
 * Common folders under `home` that directly contain Git repositories. Setup never scans them
 * unasked; it reports them so whoever runs setup, a person or an agent, can pass `--work-dir`.
 */
export const suggestRepositoryRoots = Effect.fn("Setup.suggestRepositoryRoots")(function* (
  home: string,
) {
  const links = yield* LinkStat;
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const folder of commonRepositoryFolders) {
    const path = join(home, folder);
    // On a case-insensitive volume `Work` and `work` are one folder; report it once.
    const identity = yield* links.identity.lstat(path).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
      Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.succeed(undefined)),
    );
    if (identity?.type !== "Directory" || seen.has(`${identity.dev}:${identity.ino}`)) continue;
    seen.add(`${identity.dev}:${identity.ino}`);
    for (const entry of (yield* entriesOf(path, true)).entries)
      if (
        entry.info.type === "Directory" &&
        (yield* repositoryMarker(join(path, entry.name), []))
      ) {
        suggestions.push(path);
        break;
      }
  }
  return suggestions;
});

const walkRepositoryRoots = Effect.fn("Setup.walkRepositoryRoots")(function* (
  roots: readonly string[],
) {
  const issues: SetupScanIssue[] = [];
  const visited = new Set<string>();
  const directories: string[] = [];
  const repositories = new Set<string>();
  const suppressed = new Map<string, SetupSuppressed>();
  const examine = Effect.fn("Setup.examineRepositoryCandidate")(function* (directory: string) {
    if (!visited.has(directory)) {
      visited.add(directory);
      directories.push(directory);
    }
    if (yield* repositoryMarker(directory, issues)) {
      repositories.add(directory);
      return true;
    }
    return false;
  });
  for (const configuredRoot of roots) {
    const root = resolve(configuredRoot);
    const observation = yield* entriesOf(root);
    issues.push(...observation.issues);
    if (yield* examine(root)) continue;
    for (const entry of observation.entries) {
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
    complete: issues.length === 0,
    issues,
    directoriesExamined: visited.size,
  } satisfies WalkResult;
});

const inspectWatchedRepositories = Effect.fn("Setup.inspectWatchedRepositories")(function* (
  repositories: readonly string[],
) {
  const present: string[] = [];
  const issues: SetupScanIssue[] = [];
  for (const repository of repositories.map((path) => resolve(path)).sort()) {
    const observation = yield* entriesOf(repository);
    issues.push(...observation.issues);
    if (yield* repositoryMarker(repository, issues, true)) present.push(repository);
  }
  return {
    directories: [...present],
    repositories: present,
    suppressed: [] as SetupSuppressed[],
    complete: issues.length === 0,
    issues,
    directoriesExamined: repositories.length,
  } satisfies WalkResult;
});

const nearestRepository = (path: string, repositories: readonly string[]) =>
  repositories
    .filter((repository) => pathIsWithin(repository, path))
    .sort((left, right) => right.length - left.length)[0];

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

const folderGitStatus = (
  repository: string,
  directory: string,
  tracked: ReadonlySet<string>,
  changed: readonly { code: string; path: string }[],
): SetupGitStatus => {
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
  const status: SetupGitStatus["status"] =
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

const scanSetupRepository = Effect.fn("Setup.scanRepository")(function* (
  repository: string,
  candidates: readonly SkillHit[],
  config: SetupRepositoryConfig,
) {
  const localCandidates = candidates.filter(
    (hit) =>
      hit.repository === repository &&
      !repositoryPathExcluded(config, relative(repository, hit.path)),
  );
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
  if (Result.isFailure(trackedResult)) return { hits: localCandidates, complete: false };
  const tracked = new Set(gitPaths(trackedResult.success));
  const localDocuments = localCandidates.map((hit) =>
    posix.join(relative(repository, hit.path).split(sep).join(posix.sep), "SKILL.md"),
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
        ? folderGitStatus(repository, posix.dirname(document), tracked, changed)
        : { status: "unavailable", repository },
    });
  }
  // Keep filesystem evidence if Git cannot describe a copy; otherwise its status replaces
  // the provisional unavailable status. Each installed path has one observation.
  const byPath = new Map([...localCandidates, ...hits].map((hit) => [hit.path, hit]));
  return {
    hits: [...byPath.values()],
    complete: Result.isSuccess(statusResult) && ["missing", "valid"].includes(config.status),
  };
});

export const ownershipAt = Effect.fn("Setup.ownership")(function* (path: string) {
  const inspection = yield* inspectOwnershipMarker(path);
  if (inspection.kind === "absent") return { ownership: "unmanaged" as const };
  return inspection.kind === "valid"
    ? { ownership: "skit-managed" as const, marker: inspection.marker }
    : { ownership: "invalid-marker" as const };
});

export const collectSkillsDirectories = (
  inventory: InventoryRootOptions,
  repositories: readonly string[],
) => {
  const roots: Array<{ harness: Harness; scope: "global" | "project"; root: string }> = [];
  for (const harness of HarnessName.literals) {
    for (const { root } of readableSkillsDirectories(inventory, { kind: "global" }, [harness]))
      roots.push({ harness, scope: "global", root });
    for (const repository of repositories)
      for (const { root } of readableSkillsDirectories(
        inventory,
        { kind: "repository", root: repository },
        [harness],
      ))
        roots.push({ harness, scope: "project", root });
  }
  return roots;
};

/** Discover selected locations, routing every copy to its nearest selected repository. */
const scanSetupLocations = Effect.fn("Setup.scanLocations")(function* (
  walk: WalkResult,
  harnessRoots: ReturnType<typeof collectSkillsDirectories>,
) {
  const repositoryConfigs = yield* Effect.forEach(walk.repositories, readRepositoryConfig);
  const roots = new Map<string, boolean>([
    ...harnessRoots.map(({ root }) => [root, true] as const),
    ...repositoryConfigs.flatMap((config) =>
      PROJECT_COLLECTION_ROOTS.map((path) => [join(config.repository, path), true] as const),
    ),
  ]);
  // Explicit collections are required even when their path is also a conventional root.
  for (const config of repositoryConfigs)
    for (const entry of config.collections)
      roots.set(join(config.repository, ...entry.path.split("/")), false);
  const issues: SetupScanIssue[] = [];
  const directories = new Set([
    ...walk.directories.filter(
      (directory) => nearestRepository(directory, walk.repositories) === undefined,
    ),
    ...walk.repositories,
  ]);
  for (const [root, optional] of roots) {
    const observation = yield* entriesOf(root, optional);
    issues.push(...observation.issues);
    for (const entry of observation.entries)
      if (entry.info.type === "Directory" || entry.info.type === "SymbolicLink")
        directories.add(join(root, entry.name));
  }
  const candidates = yield* collectSkillHits([...directories], walk.repositories);
  const scans = yield* Effect.forEach(
    repositoryConfigs,
    (config) => scanSetupRepository(config.repository, candidates, config),
    { concurrency: 8 },
  );
  return {
    repositoryConfigs,
    hits: [
      ...candidates.filter((hit) => hit.repository === undefined),
      ...scans.flatMap((scan) => scan.hits),
    ],
    complete: issues.length === 0 && scans.every((scan) => scan.complete),
    issues,
  };
});

const collectBrokenLinks = Effect.fn("Setup.brokenLinks")(function* (
  roots: readonly { harness: Harness; root: string }[],
) {
  const fs = yield* FileSystem.FileSystem;
  const byPath = new Map<string, SetupBrokenLink>();
  const issues: SetupScanIssue[] = [];
  for (const { harness, root } of roots) {
    const observation = yield* entriesOf(root, true);
    issues.push(...observation.issues);
    for (const entry of observation.entries) {
      if (entry.info.type !== "SymbolicLink") continue;
      const path = join(root, entry.name);
      const targetInfo = yield* Effect.result(fs.stat(path));
      if (Result.isSuccess(targetInfo)) continue;
      if (targetInfo.failure.reason._tag === "PermissionDenied") {
        issues.push({ path, code: "UNREADABLE_PATH" });
        continue;
      }
      if (targetInfo.failure.reason._tag !== "NotFound")
        return yield* Effect.fail(targetInfo.failure);
      const targetRead = yield* Effect.result(fs.readLink(path));
      if (Result.isFailure(targetRead)) {
        if (targetRead.failure.reason._tag === "NotFound")
          issues.push({ path, code: "MISSING_PATH" });
        else if (targetRead.failure.reason._tag === "PermissionDenied")
          issues.push({ path, code: "UNREADABLE_PATH" });
        else return yield* Effect.fail(targetRead.failure);
        continue;
      }
      const target = targetRead.success;
      const prior = byPath.get(path);
      byPath.set(path, {
        path,
        target,
        harnesses: [...new Set([...(prior?.harnesses ?? []), harness])].sort(),
      });
    }
  }
  return {
    links: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    issues,
  };
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
    const descriptor = yield* readSkitDescriptor(repository).pipe(
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

/** The repository roots and decisions a setup run observes: its options over the saved config. */
const setupMachineScope = (options: SetupOptions, prior: MachineSettings.Settings) => {
  const discoveryRoots = [
    ...new Set((options.repositoryRoots ?? prior.discoveryRoots).map((path) => resolve(path))),
  ].sort();
  const existingDecisions = new Map(
    prior.repositories.map((decision) => [resolve(decision.path), decision.status]),
  );
  for (const decision of options.repositoryDecisions ?? [])
    existingDecisions.set(resolve(decision.path), decision.status);
  return { discoveryRoots, existingDecisions };
};

export const collectSetupEvidence = Effect.fn("Setup.collectEvidence")(function* (
  options: SetupOptions,
) {
  const prior = yield* MachineSettings.read(options.libraryHome);
  const { discoveryRoots, existingDecisions } = setupMachineScope(options, prior);
  const discovering =
    !options.scanDecidedRepositories ||
    (!prior.repositoryDecisionsInitialized && existingDecisions.size === 0);
  const walk = discovering
    ? yield* walkRepositoryRoots(discoveryRoots)
    : yield* inspectWatchedRepositories(
        [...existingDecisions].filter(([, status]) => status === "watched").map(([path]) => path),
      );
  const machineConfig = prior;
  const harnessRoots = collectSkillsDirectories(options.inventory, walk.repositories);
  const owner = yield* Library.Service;
  const snapshot = yield* owner.read;
  const library = snapshot._tag === "Present" ? snapshot.state : emptyLibraryState();
  const authoredCollections = yield* collectAuthoredCollections(walk.repositories, library);
  const libraryInventory = yield* scanInventory(
    library,
    harnessRoots.map(({ harness, root }) => ({ harness, root })),
  );
  const { repositoryConfigs, hits, complete, issues } = yield* scanSetupLocations(
    walk,
    harnessRoots,
  );
  const brokenLinks = yield* collectBrokenLinks(harnessRoots);
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
    snapshot,
    authoredCollections,
    libraryInventory,
    brokenLinks: brokenLinks.links,
    discoveryComplete: complete && brokenLinks.issues.length === 0,
    discoveryIssues: [
      ...new Map(
        [...walk.issues, ...issues, ...brokenLinks.issues].map((issue) => [
          `${issue.code}:${issue.path}`,
          issue,
        ]),
      ).values(),
    ].sort(
      (left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code),
    ),
    hits,
    locks,
  };
});

export type SetupEvidence = Effect.Success<ReturnType<typeof collectSetupEvidence>>;
