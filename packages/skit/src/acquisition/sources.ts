import type { DescriptorFailure } from "../failures.js";
import { semver } from "../distribution/api-contracts.js";
import { Effect, FileSystem, Predicate, Result, Schema, Scope, Stream } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import type { PlatformError } from "effect/PlatformError";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseSkillFrontmatter } from "../harnesses/frontmatter.js";
import type { SkitSource } from "../contracts.js";
import { Data } from "effect";
import {
  ArchiveEntryLimitExceeded,
  DirectSkillDocumentInvalid,
  InsecureSourceUrl,
  NoSkitDescriptorFound,
  RegistryNotConfigured,
  SourceNotFound,
  SourceRequired,
  UnsafeArchivePath,
  UnsafeGitSubpath,
  UnsafeSourceUrl,
} from "../failures.js";
import { LinkStat } from "../platform/link-stat.js";
import { copyLocalTreeEffect } from "../platform/copy-tree.js";
import { TreeError } from "../shared/tree-error.js";
import { readSkitDescriptorEffect } from "../artifact/skit.js";
import { SourceProcess, type SourceProcessFailure } from "../platform/source-process.js";

export const AGENT_SKILLS_NORMALIZATION_PROFILE = "agent-skills/v1" as const;
const ownerRepository = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const versionedRegistryId = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*@[a-zA-Z0-9._-]+$/;
const MAX_ARCHIVE_FILES = 1_000;
const MAX_EXTRACTED_BYTES = 25 * 1024 * 1024;
const DISCOVERY_SCHEMA_V2 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const discoveryName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const discoveryDigest = /^sha256:[a-f0-9]{64}$/;
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

function wellKnownLocator(value: string): SkitSource | undefined {
  const [ref, fragment] = value.split("#", 2);
  if (
    !ref ||
    value.indexOf("#") !== value.lastIndexOf("#") ||
    (fragment && !/^skills=[a-z0-9,-]+$/.test(fragment))
  )
    return undefined;
  const selected = fragment ? new URLSearchParams(fragment).get("skills") : null;
  const members = selected ? selected.split(",") : undefined;
  if (fragment && (!members?.length || members.some((name) => !discoveryName.test(name))))
    return undefined;
  return members
    ? { type: "well-known", ref: ref.replace(/\/$/, ""), members: [...new Set(members)].sort() }
    : { type: "well-known", ref: ref.replace(/\/$/, "") };
}

/** A version flag promotes ambiguous shorthand only after an existing local path gets priority. */
export const sourceInputWithVersionEffect = Effect.fn("Source.inputWithVersion")(function* (
  input: string,
  version?: string,
  cwd = process.cwd(),
) {
  if (!version || !ownerRepository.test(input)) return input;
  const probe = yield* LinkStat;
  const observed = yield* Effect.option(probe.identity.stat(resolve(cwd, input)));
  return observed._tag === "Some" ? input : `skit:${input}`;
});

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

const locatorProfiles: readonly SourceLocatorProfile[] = [
  {
    id: "canonical-insecure-registry",
    priority: -1,
    aliases: ["skit+http://"],
    recognize: (value) => {
      const match = value.match(
        /^skit\+http:\/\/([^/]+)\/([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._-]+)?)$/,
      );
      return match
        ? { type: "registry", ref: match[2], authority: `http://${match[1]}` }
        : undefined;
    },
  },
  {
    id: "canonical-registry",
    priority: 0,
    aliases: ["skit://"],
    recognize: (value) => {
      const match = value.match(
        /^skit:\/\/([^/]+)\/([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._-]+)?)$/,
      );
      return match
        ? { type: "registry", ref: match[2], authority: `https://${match[1]}` }
        : undefined;
    },
  },
  {
    id: "registry-alias",
    priority: 10,
    aliases: ["skit:", "reg:", "registry:"],
    recognize: (value) => {
      const match = value.match(
        /^(?:skit|reg|registry):([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._-]+)?)$/,
      );
      return match ? { type: "registry", ref: match[1] } : undefined;
    },
  },
  {
    id: "github-alias",
    priority: 20,
    aliases: ["gh:", "github:"],
    recognize: (value) => {
      const match = value.match(/^(?:gh|github):([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/);
      return match ? { type: "git", ref: `https://github.com/${match[1]}` } : undefined;
    },
  },
  {
    id: "versioned-registry",
    priority: 30,
    aliases: [],
    recognize: (value) =>
      versionedRegistryId.test(value) ? { type: "registry", ref: value } : undefined,
  },
  {
    id: "github-tree",
    priority: 40,
    aliases: [],
    recognize: (value) => {
      const match = value.match(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*))?$/,
      );
      if (!match) return undefined;
      const [, owner, repository, ref, subpath] = match;
      const fragment = new URLSearchParams({ ref: decodeURIComponent(ref) });
      if (subpath) fragment.set("path", decodeURIComponent(subpath));
      return {
        type: "git",
        ref: `https://github.com/${owner}/${repository.replace(/\.git$/, "")}.git#${fragment}`,
      };
    },
  },
  {
    id: "github-url",
    priority: 50,
    aliases: [],
    recognize: (value) =>
      /^https:\/\/github\.com\/[^/]+\/[^/?#]+\/?(?:#.*)?$/.test(value)
        ? { type: "git", ref: value }
        : undefined,
  },
  {
    id: "git-url",
    priority: 60,
    aliases: [],
    recognize: (value) =>
      /^(?:git@|ssh:\/\/|https:\/\/).+\.git(?:#.+)?$/.test(value)
        ? { type: "git", ref: value }
        : undefined,
  },
  {
    id: "well-known-alias",
    priority: 65,
    aliases: ["wellknown:"],
    recognize: (value) =>
      /^wellknown:https:\/\/[^\s]+$/.test(value)
        ? wellKnownLocator(value.slice("wellknown:".length))
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
            ref: value.replace(/\/\.well-known\/(?:agent-skills|skills)\/index\.json$/, ""),
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
        ? { type: "well-known", ref: url.origin }
        : undefined;
    },
  },
  {
    id: "archive-url",
    priority: 70,
    aliases: [],
    recognize: (value) =>
      value.startsWith("https://") && /\.(?:zip|tar|tar\.gz|tgz)(?:\?.*)?$/.test(value)
        ? { type: "archive", ref: value }
        : undefined,
  },
  {
    id: "document-url",
    priority: 80,
    aliases: [],
    recognize: (value) =>
      value.startsWith("https://")
        ? { type: "url", ref: canonicalizeDirectGithubUrl(value) }
        : undefined,
  },
  {
    id: "github-shorthand",
    priority: 90,
    aliases: [],
    recognize: (value) =>
      ownerRepository.test(value) ? { type: "git", ref: `https://github.com/${value}` } : undefined,
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
  | SourceRequired
  | SourceNotFound
  | UnsafeSourceUrl
  | InsecureSourceUrl
  | UnsafeGitSubpath;

export function parseSkitSourceEffect(
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
      if (observed._tag === "Some") return { type: "local", ref: local };
    }
    const source = yield* classifySource(input, cwd);
    if (source.type !== "local") return source;
    const observed = yield* Effect.option(probe.identity.stat(source.ref));
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
 * Local paths are classified without touching the filesystem; `parseSkitSourceEffect` probes and
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
    for (const profile of sourceLocatorProfiles) {
      const source = profile.recognize(value);
      if (source) return source;
    }
    if (value.startsWith("wellknown:")) return yield* new UnsafeSourceUrl();
    return { type: "local", ref: resolve(cwd, value) };
  });
}

export interface ResolvedSkitSource {
  source: SkitSource;
  root: string;
  /** Unmodified acquired source tree, retained separately from normalization. */
  originalRoot: string;
  /** Exact upstream revision where the source protocol exposes one. */
  sourceRevision?: string;
  /** Immutable Registry Release served by this acquisition, independent of tracking policy. */
  releaseVersion?: string;
  descriptorKind: "declared" | "generated";
  missingAgentSkillPaths?: readonly string[];
  /** Directories observed in the verbatim tree; present only for a non-publishing acquisition. */
  observedSkillPaths?: readonly string[];
}

/** Canonical, reparsable locator for a resolved Source. Shorthand never crosses this boundary. */
export function sourceLocator(source: SkitSource): string {
  if (source.type === "well-known")
    return `wellknown:${source.ref}${source.members?.length ? `#skills=${source.members.toSorted().join(",")}` : ""}`;
  if (source.type !== "registry") return source.ref;
  if (!source.authority) return `skit:${source.ref}`;
  const authority = URL.parse(source.authority);
  if (!authority) return `skit:${source.ref}`;
  return authority.protocol === "http:"
    ? `skit+http://${authority.host}/${source.ref}`
    : `skit://${authority.host}/${source.ref}`;
}

/** A source subprocess exited non-zero. Carries the command and its captured stderr. */
export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  command: string;
  exitCode: number;
  stderr: string;
}> {
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

export class SourcePolicyViolation extends Schema.TaggedError<SourcePolicyViolation>()(
  "SourcePolicyViolation",
  { reason: SourcePolicyViolationReason },
) {
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

const gitSkillSelectionKey = "skill";

/** The selected Agent Skill paths encoded in a saved Git Source locator. */
export const selectedGitSkillPaths = (ref: string): readonly string[] =>
  new URLSearchParams(ref.split("#", 2)[1] ?? "").getAll(gitSkillSelectionKey);

function parseGitRef(
  input: string,
): Effect.Effect<
  { cloneUrl: string; ref?: string; subpath?: string; skillPaths: readonly string[] },
  UnsafeGitSubpath
> {
  return Effect.gen(function* () {
    const [cloneUrl, fragment = ""] = input.split("#", 2);
    const values = new URLSearchParams(fragment);
    const ref = values.get("ref") ?? undefined;
    const subpath = values.get("path") ?? undefined;
    const skillPaths = values.getAll(gitSkillSelectionKey);
    if (subpath && (subpath.startsWith("/") || subpath.split("/").includes("..")))
      return yield* new UnsafeGitSubpath();
    if (
      skillPaths.some(
        (path) =>
          !path ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
          !path.endsWith("/SKILL.md"),
      )
    )
      return yield* new UnsafeGitSubpath();
    return { cloneUrl, ref, subpath, skillPaths };
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

export function auditExtractedSourceEffect(
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

function sourceUpdatedAtsEffect(
  skillDirectories: readonly string[],
  historyRoot: string,
): Effect.Effect<
  ReadonlyMap<string, string>,
  SourcePolicyViolation | PlatformError,
  FileSystem.FileSystem | SourceProcess
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const relativePaths = skillDirectories.map((directory) =>
      join(directory.slice(historyRoot.length + 1), "SKILL.md"),
    );
    // A local Agent Skills directory does not have to be a Git checkout. One history traversal
    // supplies the newest commit for every discovered Skill instead of one process per Skill.
    const logged = yield* Effect.option(
      commandOutputEffect(
        "git",
        ["log", "--relative", "--format=@@%cI", "--name-only", "--", ...relativePaths],
        historyRoot,
      ),
    );
    const updated = new Map<string, string>();
    if (logged._tag === "Some") {
      let timestamp: string | undefined;
      for (const line of logged.value.split(/\r?\n/)) {
        if (line.startsWith("@@")) {
          const value = line.slice(2).trim();
          timestamp =
            value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
        } else if (timestamp && line && !updated.has(line)) updated.set(line, timestamp);
      }
    }
    for (const [index, skillDirectory] of skillDirectories.entries()) {
      const relative = relativePaths[index]!;
      if (updated.has(relative)) continue;
      const path = join(skillDirectory, "SKILL.md");
      const info = yield* fs.stat(path);
      if (info.mtime._tag === "None")
        return yield* invalidSource(`Unable to read a modification time for ${path}`);
      updated.set(relative, info.mtime.value.toISOString());
    }
    return updated;
  });
}

function wrapSingleSkillEffect(
  skillDirectory: string,
  workspace: string,
  sourceUpdatedAt?: string | null,
): Effect.Effect<
  string,
  SourcePolicyViolation | TreeError | PlatformError,
  FileSystem.FileSystem | LinkStat | SourceProcess
> {
  return wrapAgentSkillsEffect([skillDirectory], workspace, sourceUpdatedAt, skillDirectory);
}

/**
 * `sourceUpdatedAt` is the Source's own modification time, when the Source has one.
 *
 * Undefined means observe it: a checkout or a local directory carries a real timestamp, in Git
 * history or on disk, and it is the same on every acquisition. Null means this Source has none,
 * which is true of a document downloaded into a fresh temporary file: its mtime is the moment we
 * wrote it, so stamping it into the wrapper made the generated release hash different on every
 * acquisition. The field is optional in the Descriptor schema, so it is omitted rather than
 * invented.
 */
function wrapAgentSkillsEffect(
  skillDirectories: string[],
  workspace: string,
  sourceUpdatedAt?: string | null,
  historyRoot = skillDirectories[0]!,
): Effect.Effect<
  string,
  SourcePolicyViolation | TreeError | PlatformError,
  FileSystem.FileSystem | LinkStat | SourceProcess
> {
  return buildAgentSkillsWrapperEffect(
    skillDirectories,
    workspace,
    sourceUpdatedAt,
    historyRoot,
  ).pipe(Effect.map(({ root }) => root));
}

/** Normalize observed installed Skills without inventing an upstream modification time. */
export const normalizeObservedAgentSkillsEffect = Effect.fn("Source.normalizeObservedSkills")(
  function* (skillDirectories: readonly string[], workspace: string, historyRoot: string) {
    return yield* buildAgentSkillsWrapperEffect(
      [...skillDirectories],
      workspace,
      null,
      historyRoot,
    );
  },
);

function buildAgentSkillsWrapperEffect(
  skillDirectories: string[],
  workspace: string,
  sourceUpdatedAt?: string | null,
  historyRoot = skillDirectories[0]!,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sourceUpdatedAts =
      sourceUpdatedAt === undefined
        ? yield* sourceUpdatedAtsEffect(skillDirectories, historyRoot)
        : undefined;
    const observedSkills: Array<{
      directory: string;
      name: string;
      sourceUpdatedAt: string | undefined;
    }> = [];
    for (const skillDirectory of skillDirectories) {
      const skillText = yield* fs.readFileString(join(skillDirectory, "SKILL.md"));
      const frontmatter = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const name =
        frontmatter?.[1].match(/^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim() ??
        basename(skillDirectory);
      observedSkills.push({
        directory: skillDirectory,
        name,
        sourceUpdatedAt:
          sourceUpdatedAt === undefined
            ? sourceUpdatedAts?.get(join(skillDirectory.slice(historyRoot.length + 1), "SKILL.md"))
            : (sourceUpdatedAt ?? undefined),
      });
    }
    const selected = sourceUpdatedAt !== undefined;
    observedSkills.sort((left, right) =>
      selected
        ? left.name.localeCompare(right.name)
        : left.directory < right.directory
          ? -1
          : left.directory > right.directory
            ? 1
            : 0,
    );
    const skills: Array<(typeof observedSkills)[number] & { safe: string }> = [];
    const used = new Set<string>();
    for (const skill of observedSkills) {
      if (selected && skills.some((prior) => prior.name === skill.name))
        return yield* invalidSource(`Selected Agent Skills declare the same name: ${skill.name}`);
      let safe =
        skill.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "skill";
      if (used.has(safe))
        safe = `${safe}-${createHash("sha256")
          .update(selected ? skill.name : skill.directory)
          .digest("hex")
          .slice(0, 6)}`;
      if (selected && used.has(safe))
        return yield* invalidSource(
          `Selected Agent Skills normalize to the same path: ${skill.name}`,
        );
      used.add(safe);
      skills.push({ ...skill, safe });
    }
    const root = join(workspace, "agent-skills-skit");
    yield* fs.makeDirectory(join(root, "skills"), { recursive: true });
    // The normalized wrapper is a copy this workspace owns. A recursive `fs.copy` is one
    // interruptible operation whose writes can land after the enclosing workspace has been
    // removed; the shared owned-copy primitive settles each namespace change and each file
    // handle, so an abandoned copy cannot recreate cleaned output.
    for (const skill of skills)
      yield* copyLocalTreeEffect(
        skill.directory,
        join(root, "skills", skill.safe),
        undefined,
        // Verbatim, matching the recursive copy this replaces: normalization stages the source
        // as it found it, and resolving link targets here would change the release hash.
        true,
      );
    const declarations = skills
      .map(
        (skill) =>
          `  - name: ${skill.safe}\n    path: skills/${skill.safe}\n${skill.sourceUpdatedAt ? `    source_updated_at: ${skill.sourceUpdatedAt}\n` : ""}    default_enabled: true`,
      )
      .join("\n");
    const title = skills.length === 1 ? skills[0].name : `${skills.length} imported skills`;
    // This Descriptor is an internal normalization adapter. Its ID is never used as
    // Collection Identity; the identity catalog derives that from the acquired Source.
    const readme = `---\nskit: 1\nslug: internal-normalized\nskills:\n${declarations}\n---\n\n# ${title}\n`;
    yield* fs.writeFileString(join(root, "README.md"), readme);
    return {
      root,
      relativePaths: new Map(skills.map((skill) => [skill.directory, join("skills", skill.safe)])),
    };
  });
}

function discoverRootEffect(
  extracted: string,
  workspace: string,
  agentSkillPaths?: readonly string[],
  allowMissingAgentSkillPaths = false,
  selectedSourceUpdatedAt?: string | null,
  verbatimOnly = false,
): Effect.Effect<
  {
    root: string;
    descriptorKind: "declared" | "generated";
    missingAgentSkillPaths?: readonly string[];
    observedSkillPaths?: readonly string[];
  },
  SourcePolicyViolation | NoSkitDescriptorFound | DescriptorFailure | TreeError | PlatformError,
  FileSystem.FileSystem | LinkStat | SourceProcess
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const probe = yield* LinkStat;
    if (agentSkillPaths?.length) {
      const skillDirectories: string[] = [];
      const missing: string[] = [];
      for (const path of [...new Set(agentSkillPaths)].sort()) {
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
        const skillDirectory = join(extracted, dirname(path));
        const info = yield* Effect.option(probe.identity.stat(join(skillDirectory, "SKILL.md")));
        if (info._tag === "None" || info.value.type !== "File") {
          if (allowMissingAgentSkillPaths) {
            missing.push(path);
            continue;
          }
          return yield* invalidSource(
            `Locked Skill path is missing from the acquired Source: ${path}`,
          );
        }
        skillDirectories.push(skillDirectory);
      }
      if (!skillDirectories.length)
        return yield* invalidSource("None of the locked Skill paths exist in the acquired Source");
      return {
        root: verbatimOnly
          ? extracted
          : yield* wrapAgentSkillsEffect(
              skillDirectories,
              workspace,
              selectedSourceUpdatedAt,
              extracted,
            ),
        descriptorKind: "generated" as const,
        missingAgentSkillPaths: missing,
        ...(verbatimOnly
          ? {
              observedSkillPaths: skillDirectories.map(
                (directory) => relative(extracted, directory) || ".",
              ),
            }
          : {}),
      };
    }
    const queue = [extracted];
    const foundSkills: string[] = [];
    let examined = 0;
    while (queue.length) {
      const directory = queue.shift()!;
      examined++;
      if (examined > 5_000)
        return yield* sourceLimitExceeded("Source discovery exceeded directory limit");
      if (yield* fs.exists(join(directory, "skit.json"))) {
        yield* readSkitDescriptorEffect(directory);
        return { root: directory, descriptorKind: "declared" as const };
      }
      if (yield* fs.exists(join(directory, "README.md"))) {
        const text = yield* fs.readFileString(join(directory, "README.md"));
        if (/^---\r?\n[\s\S]*?^skit:\s*1\s*$/m.test(text))
          return { root: directory, descriptorKind: "declared" as const };
      }
      if (yield* fs.exists(join(directory, "SKILL.md"))) {
        foundSkills.push(directory);
        continue;
      }
      // Dirent semantics: a symlinked directory is not descended into.
      for (const name of yield* fs.readDirectory(directory)) {
        if (name === ".git" || name.startsWith(".")) continue;
        const info = yield* probe.identity.lstat(join(directory, name));
        if (info.type === "Directory") queue.push(join(directory, name));
      }
    }
    if (foundSkills.length)
      return {
        root: verbatimOnly
          ? extracted
          : yield* wrapAgentSkillsEffect(foundSkills, workspace, undefined, extracted),
        descriptorKind: "generated" as const,
        ...(verbatimOnly
          ? {
              observedSkillPaths: foundSkills.map(
                (directory) => relative(extracted, directory) || ".",
              ),
            }
          : {}),
      };
    return yield* Effect.fail(new NoSkitDescriptorFound());
  });
}

/** Acquire in the caller's scope; closing that scope releases all temporary source state. */
/**
 * A transport or body rejection we expect, as opposed to a defect in our own code.
 *
 * Mapping every rejection to SourcePolicyViolation hid programming errors as ordinary bad
 * sources. This is the same narrowing publication and listing use in the CLI's RegistryHttp.
 *
 * `instanceof` is correct here and stays. These are native JS errors thrown by the platform, not
 * our Data.TaggedError types, so there is no tag to match and no Effect to catchTag on -- the
 * value arrives as `unknown` from a rejected fetch. Rewriting it to a tag check would be a
 * migration in appearance only.
 */
/* oxlint-disable skit/no-error-instanceof -- native JS errors have no tag to match. */
function sourceTransportFailure(error: unknown): SourcePolicyViolation {
  const expected =
    error instanceof TypeError ||
    error instanceof SyntaxError ||
    error instanceof DOMException ||
    (error instanceof Error && error.constructor === Error);
  if (!expected) throw error;
  return sourceTransportRejected((error as Error).message);
}
/* oxlint-enable skit/no-error-instanceof */

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
    Stream.mapError(sourceTransportFailure),
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

const acquireDiscoveryEffect = Effect.fn("Discovery.acquire")(function* (
  source: Extract<SkitSource, { type: "well-known" }>,
  workspace: string,
  verbatimOnly = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const baseUrl = source.ref.replace(/\/$/, "");
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
  if (source.members?.some((name) => !discoveryName.test(name)))
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
  const marker = Schema.decodeUnknownResult(discoverySchemaMarker)(selected.document);
  if (Result.isFailure(marker)) return yield* invalidSource("Discovery index must be an object");
  const isV2 = marker.success.$schema !== undefined;
  if (isV2 && marker.success.$schema !== DISCOVERY_SCHEMA_V2)
    return yield* invalidSource("Unsupported discovery schema");
  let entries:
    | readonly { version: "0.2.0"; entry: typeof discoveryV2Entry.Type }[]
    | readonly { version: "0.1.0"; entry: typeof discoveryV1Entry.Type }[];
  if (isV2) {
    const decoded = Schema.decodeUnknownResult(discoveryV2Index)(selected.document);
    if (Result.isFailure(decoded))
      return yield* invalidSource(`Invalid discovery index: ${decoded.failure.message}`);
    entries = decoded.success.skills.map((entry) => ({ version: "0.2.0" as const, entry }));
  } else {
    const decoded = Schema.decodeUnknownResult(discoveryV1Index)(selected.document);
    if (Result.isFailure(decoded))
      return yield* invalidSource(`Invalid discovery index: ${decoded.failure.message}`);
    entries = decoded.success.skills.map((entry) => ({ version: "0.1.0" as const, entry }));
  }
  if (!entries.length || entries.length > MAX_ARCHIVE_FILES)
    return yield* sourceLimitExceeded("Discovery index has no Skills or exceeds Skill limit");
  const selectedMembers = source.members ? new Set(source.members) : undefined;
  if (selectedMembers) {
    const found = new Set(entries.map((item) => item.entry.name));
    for (const name of selectedMembers)
      if (!found.has(name))
        return yield* invalidSource(`Selected discovery Skill is absent upstream: ${name}`);
  }
  const seen = new Set<string>();
  const acquiredDirectories: string[] = [];
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
    acquiredDirectories.push(directory);
    if (item.version === "0.2.0") {
      const artifact = item.entry;
      if (!discoveryDigest.test(artifact.digest))
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
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (digest !== artifact.digest)
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
        yield* auditExtractedSourceEffect(extracted);
        if (!(yield* fs.exists(join(extracted, "SKILL.md"))))
          return yield* invalidSource(`Discovery archive missing root SKILL.md for ${entry.name}`);
        for (const name of yield* fs.readDirectory(extracted))
          yield* copyLocalTreeEffect(join(extracted, name), join(directory, name), undefined, true);
        yield* auditExtractedSourceEffect(originalRoot);
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
  yield* auditExtractedSourceEffect(originalRoot);
  const root = verbatimOnly
    ? originalRoot
    : yield* wrapAgentSkillsEffect(acquiredDirectories, workspace, null, originalRoot);
  return {
    source,
    root,
    descriptorKind: "generated" as const,
    originalRoot,
    ...(verbatimOnly
      ? {
          observedSkillPaths: acquiredDirectories.map(
            (directory) => relative(originalRoot, directory) || ".",
          ),
        }
      : {}),
  };
});

export function resolveSkitSourceEffect(
  input: string | SkitSource,
  options: {
    cwd?: string;
    registryBaseUrl?: string;
    registryToken?: string;
    version?: string;
    /** Portable pin; the Source locator continues to own update tracking and subpath. */
    git?: { commit: string; tracking_ref: string | null };
    requireGitRevision?: boolean;
    /** Exact Agent Skills documents supplied by verified external provenance. */
    agentSkillPaths?: readonly string[];
    allowMissingAgentSkillPaths?: boolean;
    /** Retention acquisition observes bytes without creating a publication wrapper. */
    verbatimOnly?: boolean;
  } = {},
): Effect.Effect<
  ResolvedSkitSource,
  | SourcePolicyViolation
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
  FileSystem.FileSystem | LinkStat | SourceProcess | HttpClient.HttpClient | Scope.Scope
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const probe = yield* LinkStat;
    const source =
      typeof input === "string" ? yield* parseSkitSourceEffect(input, options.cwd) : input;
    if (options.git && source.type !== "git")
      return yield* invalidSource("Git revision requires a Git locator");
    if (source.type === "git" && options.requireGitRevision && !options.git)
      return yield* sourcePinMismatch(
        `Git Entry ${source.ref} has no recorded commit. Run skit update on the retaining device and sync it before acquiring on another device.`,
      );
    const workspace = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ prefix: "skit-source-" }),
      (path) => fs.remove(path, { recursive: true, force: true }).pipe(Effect.orDie),
    );
    const guard = assertArchivePaths;

    const resolved = yield* Effect.gen(function* () {
      if (source.type === "local") {
        const info = yield* probe.identity.stat(source.ref);
        const start =
          info.type === "File" && basename(source.ref) === "SKILL.md"
            ? dirname(source.ref)
            : source.ref;
        const discovered = yield* discoverRootEffect(
          start,
          workspace,
          options.agentSkillPaths,
          options.allowMissingAgentSkillPaths,
          undefined,
          options.verbatimOnly ?? false,
        );
        // Plain local directories have no upstream revision to pin.
        const revision = yield* Effect.option(
          commandOutputEffect("git", ["rev-parse", "HEAD"], start),
        );
        return {
          source,
          ...discovered,
          originalRoot: start,
          sourceRevision: revision._tag === "Some" ? revision.value.trim() : undefined,
        };
      }
      if (source.type === "git") {
        const { cloneUrl, ref, subpath, skillPaths } = yield* parseGitRef(source.ref);
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
        const root = subpath ? join(checkout, ...subpath.split("/")) : checkout;
        const selectedPaths =
          options.agentSkillPaths ?? (skillPaths.length ? skillPaths : undefined);
        const discovered = yield* discoverRootEffect(
          root,
          workspace,
          selectedPaths,
          options.allowMissingAgentSkillPaths,
          skillPaths.length ? null : undefined,
          options.verbatimOnly ?? false,
        );
        let originalRoot = root;
        if (selectedPaths?.length) {
          originalRoot = join(workspace, "git-selected-original");
          yield* fs.makeDirectory(originalRoot);
          const missing = new Set(discovered.missingAgentSkillPaths ?? []);
          for (const path of [...new Set(selectedPaths)].sort()) {
            if (missing.has(path)) continue;
            const directory = dirname(path);
            const destination = join(originalRoot, directory);
            yield* fs.makeDirectory(dirname(destination), { recursive: true });
            yield* copyLocalTreeEffect(join(root, directory), destination, undefined, true);
          }
        }
        return { source, ...discovered, originalRoot, sourceRevision };
      }
      if (source.type === "well-known")
        return yield* acquireDiscoveryEffect(source, workspace, options.verbatimOnly ?? false);
      const registryBaseUrl =
        source.type === "registry" ? (source.authority ?? options.registryBaseUrl) : undefined;
      if (source.type === "registry" && !registryBaseUrl)
        return yield* Effect.fail(new RegistryNotConfigured());
      const acquiredSource: SkitSource =
        source.type === "registry"
          ? { ...source, authority: registryBaseUrl!.replace(/\/$/, "") }
          : source;
      const locatorVersion = source.type === "registry" ? source.ref.split("@")[1] : undefined;
      if (
        source.type === "registry" &&
        locatorVersion &&
        locatorVersion !== "latest" &&
        options.version &&
        options.version !== "latest" &&
        locatorVersion !== options.version
      )
        return yield* sourceVersionDisagreement(
          "Registry locator and requested Release version disagree.",
        );
      const selectedVersion =
        locatorVersion && locatorVersion !== "latest"
          ? locatorVersion
          : (options.version ?? "latest");
      const registryReference =
        source.type === "registry"
          ? `${registryBaseUrl!.replace(/\/$/, "")}/api/skits/${source.ref.split("@")[0]}/releases/${selectedVersion}/download`
          : source.ref;
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
      let releaseVersion: string | undefined;
      if (source.type === "registry") {
        const reportedVersion = response.headers["skit-release-version"]?.trim();
        releaseVersion =
          reportedVersion ?? (selectedVersion === "latest" ? undefined : selectedVersion);
        if (!releaseVersion || !Schema.is(semver)(releaseVersion))
          return yield* sourceVersionDisagreement(
            "Registry download did not identify an immutable Release version. Upgrade the Registry or select an explicit version.",
          );
        if (selectedVersion && selectedVersion !== "latest" && selectedVersion !== releaseVersion)
          return yield* sourceVersionDisagreement(
            `Registry served Release ${releaseVersion} when ${selectedVersion} was requested.`,
          );
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
        // A downloaded document has no modification time of its own beyond what the server
        // reports; the file we just wrote only records when we wrote it.
        const lastModified = response.headers["last-modified"];
        const declared = lastModified ? Date.parse(lastModified) : Number.NaN;
        const root = yield* wrapSingleSkillEffect(
          directory,
          workspace,
          Number.isNaN(declared) ? null : new Date(declared).toISOString(),
        );
        return {
          source: acquiredSource,
          releaseVersion,
          root,
          originalRoot: directory,
          descriptorKind: "generated" as const,
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
      yield* auditExtractedSourceEffect(extracted);
      const discovered = yield* discoverRootEffect(
        extracted,
        workspace,
        undefined,
        false,
        undefined,
        options.verbatimOnly ?? false,
      );
      return { source: acquiredSource, ...discovered, originalRoot: extracted, releaseVersion };
    });
    return resolved;
  });
}

/** Resolve the default remote commit without acquiring a worktree. Explicit refs retain the
 * full fetch path because tags and arbitrary object IDs need Git's exact revision semantics. */
export const resolveUnpinnedGitHeadEffect = Effect.fn("Source.resolveGitHead")(function* (
  source: SkitSource,
) {
  if (source.type !== "git") return undefined;
  const { cloneUrl, ref } = yield* parseGitRef(source.ref);
  if (ref !== undefined) return undefined;
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
