import type { DescriptorFailure } from "../failures.js";
import { semver } from "../distribution/api-contracts.js";
import { Data, Effect, FileSystem, Path, Predicate, Schema, Scope, Stream } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import type { PlatformError } from "effect/PlatformError";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseSkillFrontmatter } from "../harnesses/frontmatter.js";
import { SkitSource, type SourceRevision } from "../library/library-contracts.js";
import {
  ArchiveEntryLimitExceeded,
  DirectSkillDocumentInvalid,
  InsecureSourceUrl,
  NoSkitDescriptorFound,
  RegistryNotConfigured,
  SourceNotFound,
  SourceRequired,
  UnsafeArchivePath,
  GitSourceFragment,
  UnsafeGitSubpath,
  UnsafeSourceUrl,
} from "../failures.js";
import { LinkStat } from "../platform/link-stat.js";
import { copyLocalTree } from "../platform/copy-tree.js";
import { TreeError } from "../shared/tree-error.js";
import { readSkitDescriptor } from "../artifact/skit.js";
import { SourceProcess, type SourceProcessFailure } from "../platform/source-process.js";
import { containedPluginPath, PluginManifestInvalid } from "./plugin-manifests.js";
import { discoveryPathExcluded, readDiscoveryExclusions } from "./discovery-exclusions.js";
export { PluginManifestInvalid } from "./plugin-manifests.js";
import { PluginSkillConflict, selectPluginMembers } from "./plugin-membership.js";
export { PluginSkillConflict } from "./plugin-membership.js";
export { SourceDiscoveryDiagnostic } from "./source-diagnostics.js";
import type { SourceDiscoveryDiagnostic } from "./source-diagnostics.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

const ownerRepository = /^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/;
const MAX_ARCHIVE_FILES = 1_000;
const MAX_EXTRACTED_BYTES = 25 * 1024 * 1024;
const DISCOVERY_SCHEMA_V2 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const discoveryName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const discoveryHash = /^sha256:[a-f0-9]{64}$/;
const discoveryV2Entry = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  type: Schema.Literals(["skill-md", "archive"]),
  url: Schema.String,
  digest: Schema.String,
});
const discoveryV1Entry = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  files: Schema.Array(Schema.String),
});
const discoveryV2Index = Schema.Struct({
  $schema: Schema.Literal(DISCOVERY_SCHEMA_V2),
  skills: Schema.Array(discoveryV2Entry),
});
const discoveryV1Index = Schema.Struct({ skills: Schema.Array(discoveryV1Entry) });
const discoverySchemaMarker = Schema.Struct({ $schema: Schema.optional(Schema.String) });
const discoveryJson = Schema.fromJsonString(Schema.Unknown);

function wellKnownSource(value: string): SkitSource | undefined {
  if (!value || value.includes("#")) return undefined;
  return { type: "well-known", origin: value.replace(/\/$/, "") };
}

function canonicalizeDirectGithubUrl(value: string): string {
  const blob = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (blob) {
    const [, owner, repository, ref, path] = blob;
    return `https://raw.githubusercontent.com/${owner}/${repository}/${ref}/${path}`;
  }
  const explicitBranch = value.match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/refs\/heads\/([^/]+)\/(.+)$/,
  );
  if (!explicitBranch) return value;
  const [, owner, repository, ref, path] = explicitBranch;
  return `https://raw.githubusercontent.com/${owner}/${repository}/${ref}/${path}`;
}

export interface SourceLocatorProfile {
  readonly id: string;
  readonly priority: number;
  readonly aliases: readonly string[];
  readonly recognize: (value: string) => SkitSource | undefined;
}

const registryName = "([a-z0-9][a-z0-9._-]*)\\/([a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9._-]+))?";
const insecureRegistryLocator = new RegExp(`^skit\\+http:\\/\\/([^/]+)\\/${registryName}$`);
const registryLocator = new RegExp(`^skit:\\/\\/([^/]+)\\/${registryName}$`);
const registryAlias = new RegExp(`^(?:skit|reg|registry):${registryName}$`);
const bareRegistryName = new RegExp(`^${registryName}$`);

const locatorProfiles: readonly SourceLocatorProfile[] = [
  {
    id: "canonical-insecure-registry",
    priority: -1,
    aliases: ["skit+http://"],
    recognize: (value) => {
      const match = value.match(insecureRegistryLocator);
      return match?.[1] && match[2] && match[3]
        ? {
            type: "registry",
            namespace: match[2],
            slug: match[3],
            ...(match[4] === undefined ? {} : { version: match[4] }),
            authority: `http://${match[1]}`,
          }
        : undefined;
    },
  },
  {
    id: "canonical-registry",
    priority: 0,
    aliases: ["skit://"],
    recognize: (value) => {
      const match = value.match(registryLocator);
      return match?.[1] && match[2] && match[3]
        ? {
            type: "registry",
            namespace: match[2],
            slug: match[3],
            ...(match[4] === undefined ? {} : { version: match[4] }),
            authority: `https://${match[1]}`,
          }
        : undefined;
    },
  },
  {
    id: "registry-alias",
    priority: 10,
    aliases: ["skit:", "reg:", "registry:"],
    recognize: (value) => {
      const match = value.match(registryAlias);
      return match?.[1] && match[2]
        ? {
            type: "registry",
            namespace: match[1],
            slug: match[2],
            ...(match[3] === undefined ? {} : { version: match[3] }),
          }
        : undefined;
    },
  },
  {
    id: "github-alias",
    priority: 20,
    aliases: ["gh:", "github:"],
    recognize: (value) => {
      const match = /^(?:gh|github):/.test(value)
        ? value.replace(/^(?:gh|github):/, "").match(ownerRepository)
        : null;
      return match?.[1] && match[2]
        ? { type: "github", owner: match[1], repository: match[2] }
        : undefined;
    },
  },
  {
    id: "versioned-registry",
    priority: 30,
    aliases: [],
    recognize: (value) => {
      const match = value.match(bareRegistryName);
      return match?.[1] && match[2] && match[3]
        ? { type: "registry", namespace: match[1], slug: match[2], version: match[3] }
        : undefined;
    },
  },
  {
    id: "github-tree",
    priority: 40,
    aliases: [],
    recognize: (value) => {
      const match = value.match(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*?))?\/?$/,
      );
      if (!match?.[1] || !match[2] || !match[3]) return undefined;
      return {
        type: "github",
        owner: match[1],
        repository: match[2].replace(/\.git$/, ""),
        ref: decodeURIComponent(match[3]),
        ...(match[4] ? { subpath: decodeURIComponent(match[4]) } : {}),
      };
    },
  },
  {
    id: "github-url",
    priority: 50,
    aliases: [],
    recognize: (value) => {
      const match = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/);
      return match?.[1] && match[2]
        ? { type: "github", owner: match[1], repository: match[2] }
        : undefined;
    },
  },
  {
    id: "git-url",
    priority: 60,
    aliases: [],
    recognize: (value) =>
      /^(?:git@|ssh:\/\/|https:\/\/)[^#]+\.git$/.test(value)
        ? { type: "git", remote: value }
        : undefined,
  },
  {
    id: "well-known-alias",
    priority: 65,
    aliases: ["wellknown:"],
    recognize: (value) =>
      /^wellknown:https:\/\/[^\s]+$/.test(value)
        ? wellKnownSource(value.slice("wellknown:".length))
        : undefined,
  },
  {
    id: "well-known-index",
    priority: 66,
    aliases: [],
    recognize: (value) =>
      /^https:\/\/.+\/\.well-known\/(?:agent-skills|skills)\/index\.json$/.test(value)
        ? {
            type: "well-known",
            origin: value.replace(/\/\.well-known\/(?:agent-skills|skills)\/index\.json$/, ""),
          }
        : undefined,
  },
  {
    id: "https-origin-discovery",
    priority: 67,
    aliases: [],
    recognize: (value) => {
      const url = URL.parse(value);
      return url?.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash
        ? { type: "well-known", origin: url.origin }
        : undefined;
    },
  },
  {
    id: "archive-url",
    priority: 70,
    aliases: [],
    recognize: (value) =>
      value.startsWith("https://") && /\.(?:zip|tar|tar\.gz|tgz)(?:\?.*)?$/.test(value)
        ? { type: "archive", url: value }
        : undefined,
  },
  {
    id: "document-url",
    priority: 80,
    aliases: [],
    recognize: (value) =>
      value.startsWith("https://")
        ? { type: "url", url: canonicalizeDirectGithubUrl(value) }
        : undefined,
  },
  {
    id: "github-shorthand",
    priority: 90,
    aliases: [],
    recognize: (value) => {
      const match = value.match(ownerRepository);
      return match?.[1] && match[2]
        ? { type: "github", owner: match[1], repository: match[2] }
        : undefined;
    },
  },
];

/** Ordered syntax catalog. Recognition finishes before any Source performs network I/O. */
export const sourceLocatorProfiles = locatorProfiles.toSorted(
  (left, right) => left.priority - right.priority,
);

function assertDirectSkillDocument(
  skillText: string,
  contentType: string,
): Effect.Effect<void, DirectSkillDocumentInvalid> {
  return Effect.gen(function* () {
    const metadata = parseSkillFrontmatter(skillText);
    if (
      /text\/html/i.test(contentType) ||
      !metadata ||
      typeof metadata.name !== "string" ||
      typeof metadata.description !== "string"
    )
      return yield* new DirectSkillDocumentInvalid();
  });
}

/** Everything classifying a source string can reject. */
export type ParseSourceFailure =
  | GitSourceFragment
  | SourceRequired
  | SourceNotFound
  | UnsafeSourceUrl
  | InsecureSourceUrl
  | UnsafeGitSubpath;

export function parseSkitSource(
  input: string,
  cwd = process.cwd(),
): Effect.Effect<SkitSource, ParseSourceFailure, LinkStat> {
  return Effect.gen(function* () {
    const probe = yield* LinkStat;
    const value = input.trim();
    // A real path wins over shorthand. This keeps `skit add fixtures/skills` local while allowing
    // the same two-segment shape to mean GitHub when no such path exists.
    if (ownerRepository.test(value)) {
      const local = resolve(cwd, value);
      const observed = yield* Effect.option(probe.identity.stat(local));
      if (observed._tag === "Some") return { type: "local", path: local };
    }
    const source = yield* classifySource(input, cwd);
    if (source.type !== "local") return source;
    const observed = yield* Effect.option(probe.identity.stat(source.path));
    if (observed._tag === "None") return yield* new SourceNotFound({ source: input.trim() });
    return source;
  });
}

/**
 * Classify a source string, failing on the declared channel.
 *
 * It used to end `return new UnsafeSourceUrl()`, so a programming mistake anywhere inside it was
 * reported as a bad source string and exited 64. It then threw its named failures and had the
 * caller narrow them back out of an `unknown`, which rebuilt the typed error channel from a value
 * that had already lost its type. Every rejection is now a `yield*` on that channel, so anything
 * still throwing in here is a defect and stays one.
 *
 * Local paths are classified without touching the filesystem; `parseSkitSource` probes and
 * raises `SourceNotFound`.
 */
function classifySource(input: string, cwd: string): Effect.Effect<SkitSource, ParseSourceFailure> {
  return Effect.gen(function* () {
    const value = input.trim();
    if (!value) return yield* new SourceRequired();
    if (value.startsWith("wellknown:")) {
      const url = URL.parse(value.slice("wellknown:".length));
      if (
        !url ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        /[\s`;|$<>]/.test(value)
      )
        return yield* new UnsafeSourceUrl();
    }
    if (value.startsWith("https://") || value.startsWith("http://")) {
      if (/[\s`;|$<>]/.test(value)) return yield* new UnsafeSourceUrl();
      // `new URL` rejects by throwing a TypeError, which is indistinguishable from a TypeError our
      // own code made. Parsing without throwing keeps that rejection a named failure.
      const url = URL.parse(value);
      if (!url) return yield* new UnsafeSourceUrl();
      if (url.protocol !== "https:" || url.username || url.password)
        return yield* new InsecureSourceUrl();
      if (url.pathname === "/" && (value.includes("?") || value.includes("#")))
        return yield* new UnsafeSourceUrl();
    }
    // A Git remote is acquired from its default branch and root, so a fragment cannot select a
    // ref or directory. Other URLs keep theirs (for example a line anchor on a SKILL.md page).
    if (value.includes("#")) {
      const withoutFragment = value.slice(0, value.indexOf("#"));
      const recognized = sourceLocatorProfiles
        .map((profile) => profile.recognize(withoutFragment))
        .find((candidate) => candidate !== undefined);
      if (recognized?.type === "git" || recognized?.type === "github")
        return yield* new GitSourceFragment({ source: value });
    }
    for (const profile of sourceLocatorProfiles) {
      const recognized = profile.recognize(value);
      if (recognized === undefined) continue;
      // Recognizers only split syntax; the schema decides whether the parts are safe.
      return yield* Schema.decodeUnknownEffect(SkitSource)(recognized).pipe(
        Effect.mapError(() =>
          recognized.type === "git" || recognized.type === "github"
            ? new UnsafeGitSubpath()
            : new UnsafeSourceUrl(),
        ),
      );
    }
    if (value.startsWith("wellknown:")) return yield* new UnsafeSourceUrl();
    return { type: "local", path: resolve(cwd, value) };
  });
}

/** A declared SKIT names its Skills in its Descriptor; plain Agent Skills are observed in place. */
type DiscoveredSkills =
  | {
      descriptorKind: "declared";
      /** Directory holding the Descriptor, inside the acquired tree. */
      root: string;
    }
  | {
      descriptorKind: "observed";
      /** Skill directories relative to `originalRoot`, `.` when it is itself the Skill. */
      foundSkillPaths: readonly string[];
      diagnostics?: readonly SourceDiscoveryDiagnostic[];
    };

export type ResolvedSkitSource = DiscoveredSkills & {
  source: SkitSource;
  /** Unmodified acquired source tree. */
  originalRoot: string;
  /** Exact upstream revision, independent of tracking policy, where the protocol names one. */
  revision?: SourceRevision;
};

/**
 * A user-facing locator for a Source, recorded in import history and shown in messages.
 * It is never parsed back: structured Sources travel as values.
 */
export function sourceLocator(source: SkitSource): string {
  switch (source.type) {
    case "github": {
      const repository = `https://github.com/${source.owner}/${source.repository}`;
      if (source.ref === undefined && source.subpath === undefined) return repository;
      const subpath = source.subpath === undefined ? "" : `/${source.subpath}`;
      return `${repository}/tree/${encodeURIComponent(source.ref ?? "HEAD")}${subpath}`;
    }
    case "git":
      return source.remote;
    case "well-known":
      return `wellknown:${source.origin}`;
    case "url":
    case "archive":
      return source.url;
    case "local":
      return source.path;
    case "registry": {
      const name = `${source.namespace}/${source.slug}${source.version === undefined ? "" : `@${source.version}`}`;
      const authority = source.authority === undefined ? null : URL.parse(source.authority);
      if (!authority) return `skit:${name}`;
      return authority.protocol === "http:"
        ? `skit+http://${authority.host}/${name}`
        : `skit://${authority.host}/${name}`;
    }
  }
}

/** A source subprocess exited non-zero. Carries the command and its captured stderr. */
export class CommandFailed
  extends Data.TaggedError("CommandFailed")<{
    command: string;
    exitCode: number;
    stderr: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check the command's output above, then retry.";
  get message(): string {
    return `${this.command} failed (${this.exitCode}): ${this.stderr}`;
  }
}

/**
 * Acquired content violated an archive or discovery limit. Untrusted input, refused.
 *
 * `status` is present only for a rejected HTTP download. It carries the response status so a
 * caller can classify the refusal (authentication, access, missing release) from the failure
 * itself rather than by matching the message text.
 */
export const SourcePolicyViolationReason = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Transport"),
    detail: Schema.String,
    status: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({ _tag: Schema.Literal("LimitExceeded"), detail: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("PinMismatch"), detail: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("VersionDisagreement"), detail: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("InvalidSource"), detail: Schema.String }),
]);
export type SourcePolicyViolationReason = typeof SourcePolicyViolationReason.Type;

export class SourcePolicyViolation
  extends Data.TaggedError("SourcePolicyViolation")<{
    reason: SourcePolicyViolationReason;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get remediation(): string {
    return this.reason._tag === "Transport"
      ? "Check that the source is reachable and that you can access it, then retry."
      : "Choose a source that stays within SKIT's acquisition limits and pins, then retry.";
  }
  get message() {
    return this.reason.detail;
  }

  get status() {
    return this.reason._tag === "Transport" ? this.reason.status : undefined;
  }
}

const invalidSource = (detail: string) =>
  new SourcePolicyViolation({ reason: { _tag: "InvalidSource", detail } });
const sourceLimitExceeded = (detail: string) =>
  new SourcePolicyViolation({ reason: { _tag: "LimitExceeded", detail } });
const sourceTransportRejected = (detail: string, status?: number) =>
  new SourcePolicyViolation({
    reason: { _tag: "Transport", detail, ...(status === undefined ? {} : { status }) },
  });
const sourcePinMismatch = (detail: string) =>
  new SourcePolicyViolation({ reason: { _tag: "PinMismatch", detail } });
const sourceVersionDisagreement = (detail: string) =>
  new SourcePolicyViolation({ reason: { _tag: "VersionDisagreement", detail } });

const sourceProcessFailure = (
  error: SourceProcessFailure,
): PlatformError | SourcePolicyViolation =>
  Predicate.isTagged(error, "SourceProcess.OutputTooLarge") ||
  Predicate.isTagged(error, "SourceProcess.TimedOut")
    ? sourceTransportRejected(error.message)
    : error;

function runEffect(
  command: string,
  args: string[],
  cwd?: string,
): Effect.Effect<void, CommandFailed | SourcePolicyViolation | PlatformError, SourceProcess> {
  return Effect.gen(function* () {
    const process = yield* SourceProcess;
    const result = yield* process
      .run(command, args, { cwd })
      .pipe(Effect.mapError(sourceProcessFailure));
    if (result.exitCode !== 0)
      return yield* new CommandFailed({
        command,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
  });
}

export function assertArchivePaths(
  paths: string[],
): Effect.Effect<void, ArchiveEntryLimitExceeded | UnsafeArchivePath> {
  return Effect.gen(function* () {
    if (paths.filter(Boolean).length > MAX_ARCHIVE_FILES)
      return yield* new ArchiveEntryLimitExceeded();
    for (const raw of paths) {
      const path = raw.trim().replace(/\\/g, "/");
      if (!path) continue;
      if (path.startsWith("/") || path.split("/").includes("..") || /^[A-Za-z]:/.test(path))
        return yield* new UnsafeArchivePath({ path: raw });
    }
  });
}

export function auditExtractedSource(
  root: string,
): Effect.Effect<void, SourcePolicyViolation | PlatformError, FileSystem.FileSystem | LinkStat> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const probe = yield* LinkStat;
    const queue = [root];
    let files = 0,
      bytes = 0;
    while (queue.length) {
      const directory = queue.shift()!;
      for (const name of yield* fs.readDirectory(directory)) {
        const path = join(directory, name);
        // lstat, never stat: a symlink must be rejected, not followed.
        const info = yield* probe.identity.lstat(path);
        if (info.type !== "Directory" && info.type !== "File")
          return yield* invalidSource(`Archive contains unsupported entry: ${name}`);
        if (info.type === "Directory") queue.push(path);
        else {
          files++;
          bytes += info.size;
        }
        if (files > MAX_ARCHIVE_FILES)
          return yield* sourceLimitExceeded("Archive contains too many files");
        if (bytes > MAX_EXTRACTED_BYTES)
          return yield* sourceLimitExceeded("Archive exceeds 25 MiB extracted size limit");
      }
    }
  });
}

function commandOutputEffect(
  command: string,
  args: string[],
  cwd?: string,
): Effect.Effect<string, CommandFailed | SourcePolicyViolation | PlatformError, SourceProcess> {
  return Effect.gen(function* () {
    const process = yield* SourceProcess;
    const result = yield* process
      .output(command, args, { cwd })
      .pipe(Effect.mapError(sourceProcessFailure));
    if (result.exitCode !== 0)
      return yield* new CommandFailed({
        command,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
    return new TextDecoder().decode(result.stdout);
  });
}

const lockedSkillDirectory = Effect.fn("Source.lockedSkillDirectory")(function* (
  root: string,
  path: string,
) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").includes("..") ||
    /^[A-Za-z]:/.test(path)
  )
    return yield* invalidSource(`Locked Skill path must be safe and relative: ${path}`);
  if (basename(path) !== "SKILL.md")
    return yield* invalidSource(`Locked Skill path must end in SKILL.md: ${path}`);
  return join(root, dirname(path));
});

/** Resolve selected Git content before discovery, without following it outside the checkout. */
const checkoutPath = Effect.fn("Source.checkoutPath")(function* (
  checkoutRoot: string,
  selectedPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const real = yield* fs.realPath(selectedPath);
  const path = relative(checkoutRoot, real);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`))
    return yield* invalidSource(
      `Selected Git path resolves outside the checkout: ${relative(checkoutRoot, selectedPath)}`,
    );
  return real;
});

function discoverRoot(
  extracted: string,
  agentSkillPaths?: readonly string[],
  selectedDirectories?: ReadonlyMap<string, string>,
  previousSkillPaths: readonly string[] = [],
  containmentRoot = extracted,
  strictPluginRoot = false,
): Effect.Effect<
  DiscoveredSkills,
  | SourcePolicyViolation
  | PluginManifestInvalid
  | PluginSkillConflict
  | NoSkitDescriptorFound
  | DescriptorFailure
  | TreeError
  | PlatformError,
  FileSystem.FileSystem | Path.Path | LinkStat | SourceProcess
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const probe = yield* LinkStat;
    if (agentSkillPaths?.length) {
      const selectedSkills: string[] = [];
      for (const path of [...new Set(agentSkillPaths)].sort()) {
        const requestedDirectory = yield* lockedSkillDirectory(extracted, path);
        const skillDirectory = selectedDirectories?.get(path) ?? requestedDirectory;
        const info = yield* Effect.option(probe.identity.stat(join(skillDirectory, "SKILL.md")));
        if (info._tag === "None" || info.value.type !== "File")
          return yield* invalidSource(
            `Locked Skill path is missing from the acquired Source: ${path}`,
          );
        yield* containedPluginPath(containmentRoot, skillDirectory, "SKILL.md");
        selectedSkills.push(relative(extracted, requestedDirectory) || ".");
      }
      if (!selectedSkills.length)
        return yield* invalidSource("None of the locked Skill paths exist in the acquired Source");
      return {
        descriptorKind: "observed" as const,
        foundSkillPaths: selectedSkills,
      };
    }
    const exclude = yield* readDiscoveryExclusions(extracted);
    const queue = [extracted];
    const directories: string[] = [];
    const foundSkills: string[] = [];
    let examined = 0;
    while (queue.length) {
      const directory = queue.shift()!;
      // A source's own fixtures, declared in its `skit.config.json`, are never its skills.
      if (directory !== extracted && discoveryPathExcluded(exclude, relative(extracted, directory)))
        continue;
      directories.push(directory);
      examined++;
      if (examined > 5_000)
        return yield* sourceLimitExceeded("Source discovery exceeded directory limit");
      if (yield* fs.exists(join(directory, "skit.json"))) {
        yield* containedPluginPath(containmentRoot, directory, "skit.json");
        yield* readSkitDescriptor(directory);
        return { root: directory, descriptorKind: "declared" as const };
      }
      if (yield* fs.exists(join(directory, "README.md"))) {
        yield* containedPluginPath(containmentRoot, directory, "README.md");
        const text = yield* fs.readFileString(join(directory, "README.md"));
        if (/^---\r?\n[\s\S]*?^skit:\s*1\s*$/m.test(text))
          return { root: directory, descriptorKind: "declared" as const };
      }
      if (yield* fs.exists(join(directory, "SKILL.md"))) {
        yield* containedPluginPath(containmentRoot, directory, "SKILL.md");
        foundSkills.push(directory);
        continue;
      }
      // Dirent semantics: a symlinked directory is not descended into.
      for (const name of yield* fs.readDirectory(directory)) {
        if (name === ".git") continue;
        const info = yield* probe.identity.lstat(join(directory, name));
        if (info.type === "Directory") queue.push(join(directory, name));
      }
    }
    const selection = yield* selectPluginMembers(
      extracted,
      directories,
      foundSkills,
      previousSkillPaths,
      containmentRoot,
      strictPluginRoot,
    );
    foundSkills.splice(0, foundSkills.length, ...selection.members);
    if (foundSkills.length)
      return {
        descriptorKind: "observed" as const,
        foundSkillPaths: foundSkills.map((directory) => relative(extracted, directory) || "."),
        ...(selection.diagnostics.length ? { diagnostics: selection.diagnostics } : {}),
      };
    return yield* Effect.fail(new NoSkitDescriptorFound());
  });
}

/** Acquire in the caller's scope; closing that scope releases all temporary source state. */
/**
 * Read a response body, failing as soon as it exceeds `limit` bytes.
 *
 * The advertised Content-Length is a hint the server controls. Counting while reading means a
 * missing, zero or dishonest header cannot make SKIT buffer an unbounded response.
 */
const readBodyWithin = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
  message: string,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  yield* response.stream.pipe(
    Stream.mapError((error) => sourceTransportRejected(error.message)),
    Stream.runForEach((chunk: Uint8Array) =>
      Effect.suspend(() => {
        size += chunk.byteLength;
        if (size > limit) return Effect.fail(sourceLimitExceeded(message));
        chunks.push(chunk);
        return Effect.void;
      }),
    ),
  );
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
});

const readDiscoveryResponse = Effect.fn("Discovery.readResponse")(function* (
  url: string,
  limit: number,
) {
  const client = HttpClient.followRedirects(HttpClient.withScope(yield* HttpClient.HttpClient));
  const response = yield* client
    .execute(HttpClientRequest.get(url))
    .pipe(Effect.mapError((error) => sourceTransportRejected(error.message)));
  if (response.status === 404) return undefined;
  if (response.status < 200 || response.status >= 300)
    return yield* sourceTransportRejected(
      `Discovery download failed: ${response.status}`,
      response.status,
    );
  return yield* readBodyWithin(response, limit, "Discovery response exceeds size limit");
});

const fetchDiscovery = Effect.fn("Discovery.fetch")(function* (
  source: Extract<SkitSource, { type: "well-known" }>,
  workspace: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const baseUrl = source.origin.replace(/\/$/, "");
  const parsedBase = URL.parse(baseUrl);
  if (
    !parsedBase ||
    parsedBase.protocol !== "https:" ||
    parsedBase.username ||
    parsedBase.password ||
    parsedBase.hash ||
    parsedBase.search
  )
    return yield* invalidSource("Discovery Source requires a safe HTTPS base URL");
  if (source.skillNames?.some((name) => !discoveryName.test(name)))
    return yield* invalidSource("Discovery member selection contains an invalid Skill name");
  const candidates = [".well-known/agent-skills", ".well-known/skills"];
  let selected: { indexUrl: string; path: string; document: unknown } | undefined;
  for (const path of candidates) {
    const indexUrl = `${baseUrl}/${path}/index.json`;
    const body = yield* readDiscoveryResponse(indexUrl, 2 * 1024 * 1024);
    if (!body) continue;
    const document = yield* Schema.decodeUnknownEffect(discoveryJson)(
      new TextDecoder().decode(body),
    ).pipe(Effect.mapError((error) => invalidSource(`Invalid discovery index: ${error.message}`)));
    selected = { indexUrl, path, document };
    break;
  }
  if (!selected)
    return yield* new SourceNotFound({ source: `${baseUrl}/.well-known/agent-skills/index.json` });
  const marker = yield* Schema.decodeUnknownEffect(discoverySchemaMarker)(selected.document).pipe(
    Effect.mapError(() => invalidSource("Discovery index must be an object")),
  );
  const isV2 = marker.$schema !== undefined;
  if (isV2 && marker.$schema !== DISCOVERY_SCHEMA_V2)
    return yield* invalidSource("Unsupported discovery schema");
  let entries:
    | readonly { version: "0.2.0"; entry: typeof discoveryV2Entry.Type }[]
    | readonly { version: "0.1.0"; entry: typeof discoveryV1Entry.Type }[];
  if (isV2) {
    const decoded = yield* Schema.decodeUnknownEffect(discoveryV2Index)(selected.document).pipe(
      Effect.mapError((error) => invalidSource(`Invalid discovery index: ${error.message}`)),
    );
    entries = decoded.skills.map((entry) => ({ version: "0.2.0" as const, entry }));
  } else {
    const decoded = yield* Schema.decodeUnknownEffect(discoveryV1Index)(selected.document).pipe(
      Effect.mapError((error) => invalidSource(`Invalid discovery index: ${error.message}`)),
    );
    entries = decoded.skills.map((entry) => ({ version: "0.1.0" as const, entry }));
  }
  if (!entries.length || entries.length > MAX_ARCHIVE_FILES)
    return yield* sourceLimitExceeded("Discovery index has no Skills or exceeds Skill limit");
  const selectedMembers = source.skillNames ? new Set(source.skillNames) : undefined;
  if (selectedMembers) {
    const found = new Set(entries.map((item) => item.entry.name));
    for (const name of selectedMembers)
      if (!found.has(name))
        return yield* invalidSource(`Selected discovery Skill is absent upstream: ${name}`);
  }
  const seen = new Set<string>();
  const importedDirectories: string[] = [];
  let downloadedBytes = 0;
  let regularBytes = 0;
  const originalRoot = join(workspace, "discovery-original");
  yield* fs.makeDirectory(originalRoot);
  for (const item of entries) {
    const entry = item.entry;
    if (!discoveryName.test(entry.name) || entry.name.length > 64 || seen.has(entry.name))
      return yield* invalidSource(`Invalid or duplicate discovery Skill name: ${entry.name}`);
    seen.add(entry.name);
    if (selectedMembers && !selectedMembers.has(entry.name)) continue;
    const directory = join(originalRoot, entry.name);
    yield* fs.makeDirectory(directory);
    importedDirectories.push(directory);
    if (item.version === "0.2.0") {
      const artifact = item.entry;
      if (!discoveryHash.test(artifact.digest))
        return yield* invalidSource(`Invalid discovery digest for ${entry.name}`);
      const artifactUrl = URL.parse(artifact.url, selected.indexUrl);
      if (
        !artifactUrl ||
        artifactUrl.protocol !== "https:" ||
        artifactUrl.username ||
        artifactUrl.password
      )
        return yield* invalidSource(`Unsafe discovery artifact URL for ${entry.name}`);
      const bytes = yield* readDiscoveryResponse(
        artifactUrl.toString(),
        artifact.type === "skill-md" ? 2 * 1024 * 1024 : 25 * 1024 * 1024,
      );
      if (!bytes) return yield* new SourceNotFound({ source: artifactUrl.toString() });
      downloadedBytes += bytes.byteLength;
      if (downloadedBytes > 256 * 1024 * 1024)
        return yield* sourceLimitExceeded("Discovery downloads exceed 256 MiB limit");
      const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (hash !== artifact.digest)
        return yield* sourcePinMismatch(`Discovery artifact digest disagrees for ${entry.name}`);
      if (artifact.type === "skill-md") {
        regularBytes += bytes.byteLength;
        if (regularBytes > MAX_EXTRACTED_BYTES)
          return yield* sourceLimitExceeded("Discovery files exceed 25 MiB limit");
        const text = new TextDecoder().decode(bytes);
        yield* assertDirectSkillDocument(text, "text/plain");
        yield* fs.writeFileString(join(directory, "SKILL.md"), text);
      } else {
        const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
        const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
        if (!zip && !gzip)
          return yield* invalidSource(`Unsupported discovery archive for ${entry.name}`);
        const archive = join(workspace, `${entry.name}${zip ? ".zip" : ".tar.gz"}`);
        yield* fs.writeFile(archive, bytes);
        const extracted = join(workspace, `extracted-${entry.name}`);
        yield* fs.makeDirectory(extracted);
        if (archive.endsWith(".zip")) {
          const listing = yield* commandOutputEffect("unzip", ["-Z1", archive]);
          yield* assertArchivePaths(listing.split("\n"));
          const modes = yield* commandOutputEffect("unzip", ["-Z", "-l", archive]);
          if (/^[lh][rwxstST-]{9}\s/m.test(modes))
            return yield* invalidSource(`Discovery archive contains a link: ${entry.name}`);
          yield* runEffect("unzip", ["-q", archive, "-d", extracted]);
        } else {
          const listing = yield* commandOutputEffect("tar", ["-tzf", archive]);
          yield* assertArchivePaths(listing.split("\n"));
          const modes = yield* commandOutputEffect("tar", ["-tvzf", archive]);
          if (/^[lh][rwxstST-]{9}\s/m.test(modes))
            return yield* invalidSource(`Discovery archive contains a link: ${entry.name}`);
          yield* runEffect("tar", [
            "-xzf",
            archive,
            "-C",
            extracted,
            "--no-same-owner",
            "--no-same-permissions",
          ]);
        }
        yield* auditExtractedSource(extracted);
        if (!(yield* fs.exists(join(extracted, "SKILL.md"))))
          return yield* invalidSource(`Discovery archive missing root SKILL.md for ${entry.name}`);
        for (const name of yield* fs.readDirectory(extracted))
          yield* copyLocalTree(join(extracted, name), join(directory, name), undefined, true);
        yield* auditExtractedSource(originalRoot);
      }
    } else {
      const legacy = item.entry;
      if (
        !legacy.files.some((file) => file.toLowerCase() === "skill.md") ||
        legacy.files.length > MAX_ARCHIVE_FILES
      )
        return yield* invalidSource(`Legacy discovery Skill ${entry.name} must list SKILL.md`);
      const listed = new Set<string>();
      for (const file of legacy.files) {
        const segments = file.split("/");
        if (
          !file ||
          file.startsWith("/") ||
          file.includes("\\") ||
          segments.some((segment) => !segment || segment === "." || segment === "..") ||
          file.includes("\0")
        )
          return yield* invalidSource(`Unsafe legacy discovery file path: ${file}`);
        const relative = file.toLowerCase() === "skill.md" ? "SKILL.md" : file;
        if (listed.has(relative))
          return yield* invalidSource(`Duplicate legacy discovery file path: ${file}`);
        listed.add(relative);
        const url = `${baseUrl}/${selected.path}/${entry.name}/${segments.map(encodeURIComponent).join("/")}`;
        const bytes = yield* readDiscoveryResponse(url, 2 * 1024 * 1024);
        if (!bytes) return yield* new SourceNotFound({ source: url });
        downloadedBytes += bytes.byteLength;
        regularBytes += bytes.byteLength;
        if (downloadedBytes > 256 * 1024 * 1024 || regularBytes > MAX_EXTRACTED_BYTES)
          return yield* sourceLimitExceeded("Discovery files exceed size limit");
        const destination = join(directory, relative);
        yield* fs.makeDirectory(dirname(destination), { recursive: true });
        yield* fs.writeFile(destination, bytes);
      }
    }
  }
  yield* auditExtractedSource(originalRoot);
  return {
    source,
    descriptorKind: "observed" as const,
    originalRoot,
    foundSkillPaths: importedDirectories.map(
      (directory) => relative(originalRoot, directory) || ".",
    ),
  };
});

export function resolveSkitSource(
  input: string | SkitSource,
  options: {
    cwd?: string;
    registryBaseUrl?: string;
    registryToken?: string;
    /** Exact commit to acquire when restoring; `tracking_ref` must match the Source's `ref`. */
    git?: { commit: string; tracking_ref: string | null };
    requireGitRevision?: boolean;
    /** Existing Collection membership to preserve while discovering newly added Skills. */
    previousSkillPaths?: readonly string[];
  } = {},
): Effect.Effect<
  ResolvedSkitSource,
  | SourcePolicyViolation
  | PluginManifestInvalid
  | PluginSkillConflict
  | UnsafeArchivePath
  | ArchiveEntryLimitExceeded
  | CommandFailed
  | ParseSourceFailure
  | DirectSkillDocumentInvalid
  | NoSkitDescriptorFound
  | RegistryNotConfigured
  | DescriptorFailure
  | TreeError
  | PlatformError,
  FileSystem.FileSystem | Path.Path | LinkStat | SourceProcess | HttpClient.HttpClient | Scope.Scope
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const probe = yield* LinkStat;
    const source = typeof input === "string" ? yield* parseSkitSource(input, options.cwd) : input;
    const gitSource = source.type === "git" || source.type === "github";
    if (options.git && !gitSource)
      return yield* invalidSource("Git revision requires a Git locator");
    if (gitSource && options.requireGitRevision && !options.git)
      return yield* sourcePinMismatch(
        `Git Entry ${sourceLocator(source)} has no recorded commit. Run skit update on the retaining device and sync it before acquiring on another device.`,
      );
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-source-" });
    const guard = assertArchivePaths;

    const resolved = yield* Effect.gen(function* () {
      if (source.type === "local") {
        const info = yield* probe.identity.stat(source.path);
        const selectedStart =
          info.type === "File" && basename(source.path) === "SKILL.md"
            ? dirname(source.path)
            : source.path;
        // An explicitly selected directory link names its target's content. Retaining
        // the relative link itself at a new staging root would make it dangling.
        // The observed local Git revision likewise belongs to the retained target.
        const start =
          (yield* probe.identity.lstat(selectedStart)).type === "SymbolicLink"
            ? yield* fs.realPath(selectedStart)
            : selectedStart;
        const discovered = yield* discoverRoot(
          start,
          undefined,
          undefined,
          options.previousSkillPaths,
          start,
        );
        // Plain local directories have no upstream revision to pin.
        const head = yield* Effect.option(commandOutputEffect("git", ["rev-parse", "HEAD"], start));
        return {
          source,
          ...discovered,
          originalRoot: start,
          revision:
            head._tag === "Some"
              ? { kind: "commit" as const, commit: head.value.trim() }
              : undefined,
        };
      }
      if (source.type === "git" || source.type === "github") {
        const cloneUrl =
          source.type === "github"
            ? `https://github.com/${source.owner}/${source.repository}`
            : source.remote;
        const { ref, subpath } = source;
        const skillPaths = (source.skillDirectories ?? []).map((directory) =>
          join(directory, "SKILL.md"),
        );
        const checkout = join(workspace, "checkout");
        if (
          options.git &&
          (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.git.commit) ||
            options.git.tracking_ref !== (ref ?? null))
        )
          return yield* sourcePinMismatch(
            "Invalid Git commit or tracking ref disagrees with locator",
          );
        // Fetch a commit explicitly: clone --branch cannot acquire an object ID.
        // No depth limit: normalization preserves each Skill's committed modification time.
        const revision = options.git?.commit ?? ref ?? "HEAD";
        const ordinaryHead = options.git === undefined && ref === undefined;
        yield* Effect.gen(function* () {
          // Let Git negotiate the repository object format (SHA-1 or SHA-256).
          // No worktree is materialized until the requested commit has been fetched.
          yield* runEffect("git", [
            "clone",
            "--filter=blob:none",
            "--no-checkout",
            "--single-branch",
            "--",
            cloneUrl,
            checkout,
          ]);
          if (!ordinaryHead)
            yield* runEffect(
              "git",
              ["fetch", "--filter=blob:none", "--", "origin", revision],
              checkout,
            );
        }).pipe(
          Effect.catchTag("CommandFailed", (error) =>
            Effect.fail(
              new CommandFailed({
                ...error,
                stderr: `Cannot acquire Git revision ${revision} from ${cloneUrl}. Restore access to that revision or explicitly run skit update on the retaining device and sync again. No newer revision was substituted. ${error.stderr}`,
              }),
            ),
          ),
        );
        yield* runEffect(
          "git",
          ["checkout", "--detach", ordinaryHead ? "HEAD" : "FETCH_HEAD"],
          checkout,
        );
        const sourceRevision = (yield* commandOutputEffect(
          "git",
          ["rev-parse", "HEAD"],
          checkout,
        )).trim();
        if (options.git && sourceRevision !== options.git.commit)
          return yield* sourcePinMismatch(
            `Git returned ${sourceRevision} instead of pinned commit ${options.git.commit}`,
          );
        const checkoutRoot = yield* fs.realPath(checkout);
        const root = yield* checkoutPath(
          checkoutRoot,
          subpath ? join(checkoutRoot, ...subpath.split("/")) : checkoutRoot,
        ).pipe(
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(
              error.reason._tag === "NotFound"
                ? invalidSource(
                    `Selected Git path is missing or its symlink target is unavailable: ${subpath ?? "."}. Verify the directory and link target, then retry.`,
                  )
                : error,
            ),
          ),
        );
        const selectedPaths = skillPaths.length ? skillPaths : undefined;
        const selectedDirectories = new Map<string, string>();
        for (const path of [...new Set(selectedPaths)].sort()) {
          const requested = yield* lockedSkillDirectory(root, path);
          const directory = yield* checkoutPath(checkoutRoot, requested).pipe(
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
            ),
          );
          if (directory !== undefined) selectedDirectories.set(path, directory);
        }
        const discovered = yield* discoverRoot(
          root,
          selectedPaths,
          selectedDirectories,
          options.previousSkillPaths,
          checkoutRoot,
          // Enforce declarations for an explicitly selected plugin root.
          Boolean(source.subpath),
        );
        let originalRoot = root;
        if (selectedPaths?.length) {
          originalRoot = join(workspace, "git-selected-original");
          for (const path of [...new Set(selectedPaths)].sort()) {
            const selectedDirectory = selectedDirectories.get(path);
            if (selectedDirectory === undefined)
              return yield* invalidSource(
                `Locked Skill path is missing from the acquired Source: ${path}`,
              );
            const destination = join(originalRoot, dirname(path));
            yield* fs.makeDirectory(dirname(destination), { recursive: true });
            yield* copyLocalTree(selectedDirectory, destination, undefined, true);
          }
        }
        return {
          source,
          ...discovered,
          originalRoot,
          revision: { kind: "commit" as const, commit: sourceRevision },
        };
      }
      if (source.type === "well-known") return yield* fetchDiscovery(source, workspace);
      const registryBaseUrl =
        source.type === "registry" ? (source.authority ?? options.registryBaseUrl) : undefined;
      if (source.type === "registry" && !registryBaseUrl)
        return yield* Effect.fail(new RegistryNotConfigured());
      const importedSource: SkitSource =
        source.type === "registry"
          ? { ...source, authority: registryBaseUrl!.replace(/\/$/, "") }
          : source;
      const selectedVersion = (source.type === "registry" ? source.version : undefined) ?? "latest";
      const registryReference =
        source.type === "registry"
          ? `${registryBaseUrl!.replace(/\/$/, "")}/api/skits/${source.namespace}/${source.slug}/releases/${selectedVersion}/download`
          : source.url;
      // The scoped client owns the response body alongside the temporary workspace.
      let request = HttpClientRequest.get(registryReference);
      const registryCredentialMatches =
        source.type === "registry" &&
        (!source.authority ||
          (options.registryBaseUrl &&
            source.authority.replace(/\/$/, "") === options.registryBaseUrl.replace(/\/$/, "")));
      if (source.type === "registry" && options.registryToken && registryCredentialMatches)
        request = HttpClientRequest.bearerToken(request, options.registryToken);
      const client = HttpClient.followRedirects(HttpClient.withScope(yield* HttpClient.HttpClient));
      const response = yield* client
        .execute(request)
        .pipe(Effect.mapError((error) => sourceTransportRejected(error.message)));
      if (response.status === 404) return yield* new SourceNotFound({ source: registryReference });
      if (response.status < 200 || response.status >= 300) {
        return yield* sourceTransportRejected(
          `SKIT download failed: ${response.status}`,
          response.status,
        );
      }
      let revision: SourceRevision | undefined;
      if (source.type === "registry") {
        const reportedVersion = response.headers["skit-release-version"]?.trim();
        const releaseVersion =
          reportedVersion ?? (selectedVersion === "latest" ? undefined : selectedVersion);
        if (!releaseVersion || !Schema.is(semver)(releaseVersion))
          return yield* sourceVersionDisagreement(
            "Registry download did not identify an immutable Release version. Upgrade the Registry or select an explicit version.",
          );
        if (selectedVersion && selectedVersion !== "latest" && selectedVersion !== releaseVersion)
          return yield* sourceVersionDisagreement(
            `Registry served Release ${releaseVersion} when ${selectedVersion} was requested.`,
          );
        revision = { kind: "release", version: releaseVersion };
      }
      const contentLength = Number(response.headers["content-length"] ?? "0");
      if (contentLength > 256 * 1024 * 1024) {
        return yield* sourceLimitExceeded("SKIT source exceeds 256 MiB limit");
      }
      const type = response.headers["content-type"] ?? "";
      const direct =
        /markdown|text\/plain/.test(type) ||
        registryReference.toLowerCase().split("?")[0].endsWith("/skill.md");
      // Which limit applies is known from the headers and the URL, so the real byte count can be
      // enforced while reading instead of after the whole response is already in memory.
      const body = yield* readBodyWithin(
        response,
        direct ? 2 * 1024 * 1024 : 256 * 1024 * 1024,
        direct ? "Direct SKILL.md exceeds 2 MiB limit" : "SKIT source exceeds 256 MiB limit",
      );
      if (direct) {
        const directory = join(workspace, "direct-skill");
        yield* fs.makeDirectory(directory);
        const skillText = new TextDecoder().decode(body);
        yield* assertDirectSkillDocument(skillText, type);
        yield* fs.writeFileString(join(directory, "SKILL.md"), skillText);
        return {
          source: importedSource,
          revision,
          originalRoot: directory,
          descriptorKind: "observed" as const,
          foundSkillPaths: ["."],
        };
      }
      const archive = join(
        workspace,
        registryReference.match(/\.(?:tar\.gz|tgz)(?:\?|$)/)
          ? "source.tar.gz"
          : registryReference.match(/\.tar(?:\?|$)/)
            ? "source.tar"
            : "source.zip",
      );
      yield* fs.writeFile(archive, body);
      const extracted = join(workspace, "extracted");
      yield* fs.makeDirectory(extracted);
      if (archive.endsWith(".zip")) {
        const listing = yield* commandOutputEffect("unzip", ["-Z1", archive]);
        yield* guard(listing.split("\n"));
        yield* runEffect("unzip", ["-q", archive, "-d", extracted]);
      } else if (archive.endsWith(".tar.gz")) {
        const listing = yield* commandOutputEffect("tar", ["-tzf", archive]);
        yield* guard(listing.split("\n"));
        yield* runEffect("tar", [
          "-xzf",
          archive,
          "-C",
          extracted,
          "--no-same-owner",
          "--no-same-permissions",
        ]);
      } else {
        const listing = yield* commandOutputEffect("tar", ["-tf", archive]);
        yield* guard(listing.split("\n"));
        yield* runEffect("tar", [
          "-xf",
          archive,
          "-C",
          extracted,
          "--no-same-owner",
          "--no-same-permissions",
        ]);
      }
      yield* auditExtractedSource(extracted);
      const discovered = yield* discoverRoot(
        extracted,
        undefined,
        undefined,
        options.previousSkillPaths,
        extracted,
      );
      return { source: importedSource, ...discovered, originalRoot: extracted, revision };
    }).pipe(
      Effect.catchTag("PluginSkillConflict", (error) =>
        Effect.fail(
          new PluginSkillConflict({
            name: error.name,
            paths: error.paths,
            directories: error.directories,
            ...(source.type === "github"
              ? {
                  locators: error.directories.map((directory) =>
                    sourceLocator({
                      ...source,
                      subpath: join(source.subpath ?? ".", directory)
                        .split(sep)
                        .join("/"),
                    }),
                  ),
                }
              : source.type === "local"
                ? { locators: error.directories.map((directory) => join(source.path, directory)) }
                : {}),
          }),
        ),
      ),
    );
    // Manifest-selected directory links must retain target content at the original member path.
    if (resolved.descriptorKind === "observed") {
      const targets = new Map<string, string>();
      for (const path of resolved.foundSkillPaths) {
        const selected = join(resolved.originalRoot, path);
        const target = yield* fs.realPath(selected);
        if (target !== (yield* fs.realPath(dirname(selected))) + sep + basename(selected))
          targets.set(path, target);
      }
      if (targets.size) {
        const originalRoot = join(workspace, "manifest-selected-original");
        for (const path of resolved.foundSkillPaths) {
          const destination = join(originalRoot, path);
          yield* fs.makeDirectory(dirname(destination), { recursive: true });
          yield* copyLocalTree(
            targets.get(path) ?? join(resolved.originalRoot, path),
            destination,
            undefined,
            true,
          );
        }
        return { ...resolved, originalRoot };
      }
    }
    return resolved;
  });
}

/** Resolve the default remote commit without acquiring a worktree. Explicit refs retain the
 * full fetch path because tags and arbitrary object IDs need Git's exact revision semantics. */
export const resolveUnpinnedGitHead = Effect.fn("Source.resolveGitHead")(function* (
  source: SkitSource,
) {
  if (source.type !== "git" && source.type !== "github") return undefined;
  if (source.ref !== undefined) return undefined;
  const cloneUrl =
    source.type === "github"
      ? `https://github.com/${source.owner}/${source.repository}`
      : source.remote;
  const output = yield* commandOutputEffect("git", [
    "ls-remote",
    "--exit-code",
    "--",
    cloneUrl,
    "HEAD",
  ]);
  const commit = output.trim().split(/\s+/, 1)[0];
  if (!commit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
    return yield* sourcePinMismatch(`Git returned no commit for ${cloneUrl} HEAD`);
  return commit;
});
