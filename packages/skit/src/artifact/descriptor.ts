// The SKIT Descriptor and Skill projection rules: parsing, normalisation and content hashing.
// Everything here is pure computation over strings and bytes so the Registry Worker can share
// it with the CLI. Filesystem-backed workflows over a SKIT directory live in skit.ts.

import { Effect, Result, Schema } from "effect";
// Hashing is deterministic computation, not IO, so it stays on node:crypto.
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { encodeHashParts } from "../shared/digest.js";
import type { Digest, SkillExampleManifest, SkitDescriptor } from "../contracts.js";
import {
  containedSkillSchema,
  skillExampleSchema,
  skitConfigSchema,
  skitDescriptorSchema,
} from "../schemas.js";
import {
  DescriptorMalformed,
  ConflictingInvocationDeclaration,
  DuplicateSkillNames,
  DuplicateSkillPaths,
  ProjectedPathCollision,
  ReadmeFrontmatterMissing,
  SharedTargetCollision,
} from "../failures.js";

type ParsedSkill = typeof containedSkillSchema.Type;
type DescriptorObject = { [key: string]: unknown };

function legacyInvocation(triggerModes: unknown): SkitDescriptor["skills"][number]["invocation"] {
  if (!Array.isArray(triggerModes)) return undefined;
  if (triggerModes.includes("host_policy")) return "host-policy";
  if (triggerModes.includes("implicit")) return "implicit";
  if (triggerModes.includes("explicit")) return "explicit";
  return undefined;
}

export function normalizeDescriptorDeclarations(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const descriptor = value as DescriptorObject;
  if (!Array.isArray(descriptor.skills)) return value;
  return {
    ...descriptor,
    skills: descriptor.skills.map((input) => {
      if (!input || typeof input !== "object") return input;
      const skill = input as DescriptorObject;
      const legacy = legacyInvocation(skill.trigger_modes);
      if (typeof skill.invocation === "string" && legacy && skill.invocation !== legacy)
        throw new ConflictingInvocationDeclaration({ skill: String(skill.name ?? "Skill") });
      const {
        trigger_modes: _triggerModes,
        mutation_scopes: _mutationScopes,
        approval: _approval,
        expected_outputs: _expectedOutputs,
        capabilities: declaredCapabilities,
        ...current
      } = skill;
      const invocation = typeof skill.invocation === "string" ? skill.invocation : legacy;
      return {
        ...current,
        ...(invocation ? { invocation } : {}),
        ...(Array.isArray(declaredCapabilities) && declaredCapabilities.length > 0
          ? { capabilities: declaredCapabilities }
          : {}),
      };
    }),
  };
}

function normalizeContainedSkill(skill: ParsedSkill): SkitDescriptor["skills"][number] {
  const normalized = normalizeDescriptorDeclarations({ skills: [skill] }) as {
    skills: DescriptorObject[];
  };
  const current = normalized.skills[0];
  return {
    ...current,
    name: skill.name,
    path: skill.path,
    default_enabled: skill.default_enabled,
  } as SkitDescriptor["skills"][number];
}

export function parseSkitReadme(text: string): SkitDescriptor {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new ReadmeFrontmatterMissing();
  const input = parseYaml(match[1]);
  // Generated Agent Skills wrappers used these sentinel IDs before Descriptor
  // identity moved to `slug`. Retained artifacts are immutable, so normalize
  // only the two values SKIT itself emitted rather than accepting legacy IDs
  // in authored Descriptors generally.
  if (input && typeof input === "object") {
    const descriptor = input as DescriptorObject;
    if (
      !("slug" in descriptor) &&
      (descriptor.id === "internal/normalized" || descriptor.id === "local/internal-normalized")
    ) {
      descriptor.slug = "internal-normalized";
      delete descriptor.id;
    }
  }
  const parsed = Schema.decodeUnknownSync(skitDescriptorSchema, {
    onExcessProperty: "error",
  })(input);
  const descriptor: SkitDescriptor = {
    ...parsed,
    skills: parsed.skills.map(normalizeContainedSkill),
  };
  if (new Set(descriptor.skills.map((skill) => skill.name)).size !== descriptor.skills.length)
    throw new DuplicateSkillNames();
  if (new Set(descriptor.skills.map((skill) => skill.path)).size !== descriptor.skills.length)
    throw new DuplicateSkillPaths();
  return descriptor;
}

export function parseSkitConfig(text: string): SkitDescriptor {
  const config = Schema.decodeUnknownSync(skitConfigSchema, {
    onExcessProperty: "error",
  })(JSON.parse(text));
  const descriptor: SkitDescriptor = {
    skit: 1,
    slug: config.slug,
    ...(config.sameAs ? { sameAs: config.sameAs } : {}),
    ...(config.author ? { author: config.author } : {}),
    skills: config.skills.map((skill) =>
      normalizeContainedSkill({ ...skill, default_enabled: skill.default_enabled ?? true }),
    ),
  };
  if (new Set(descriptor.skills.map((skill) => skill.name)).size !== descriptor.skills.length)
    throw new DuplicateSkillNames();
  if (new Set(descriptor.skills.map((skill) => skill.path)).size !== descriptor.skills.length)
    throw new DuplicateSkillPaths();
  return descriptor;
}

const malformed = (format: "json" | "yaml", detail: string) =>
  new DescriptorMalformed({ format, detail });

const JsonDocument = Schema.fromJsonString(Schema.Unknown);

const normalizeSkillsEffect = Effect.fn("Descriptor.normalizeSkills")(function* (
  skills: readonly ParsedSkill[],
) {
  for (const skill of skills) {
    const legacy = legacyInvocation((skill as DescriptorObject).trigger_modes);
    if (typeof skill.invocation === "string" && legacy && skill.invocation !== legacy)
      return yield* new ConflictingInvocationDeclaration({ skill: skill.name });
  }
  return skills.map(normalizeContainedSkill);
});

const validateDescriptorEffect = Effect.fn("Descriptor.validate")(function* (
  input: unknown,
  format: "json" | "yaml",
) {
  const parsed = yield* Schema.decodeUnknownEffect(skitDescriptorSchema, {
    onExcessProperty: "error",
    errors: "all",
  })(input).pipe(Effect.mapError((error) => malformed(format, error.message)));
  const skills = yield* normalizeSkillsEffect(parsed.skills);
  const descriptor: SkitDescriptor = { ...parsed, skills };
  if (new Set(skills.map((skill) => skill.name)).size !== skills.length)
    return yield* new DuplicateSkillNames();
  if (new Set(skills.map((skill) => skill.path)).size !== skills.length)
    return yield* new DuplicateSkillPaths();
  return descriptor;
});

export const parseSkitReadmeEffect = Effect.fn("Descriptor.parseReadme")(function* (text: string) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return yield* new ReadmeFrontmatterMissing();
  const input = yield* Effect.try({
    try: () => parseYaml(match[1]) as unknown,
    catch: (error) => malformed("yaml", String(error)),
  });
  if (input && typeof input === "object") {
    const descriptor = input as DescriptorObject;
    if (
      !("slug" in descriptor) &&
      (descriptor.id === "internal/normalized" || descriptor.id === "local/internal-normalized")
    ) {
      descriptor.slug = "internal-normalized";
      delete descriptor.id;
    }
  }
  return yield* validateDescriptorEffect(input, "yaml");
});

export const parseSkitConfigEffect = Effect.fn("Descriptor.parseConfig")(function* (text: string) {
  const input = yield* Schema.decodeUnknownEffect(JsonDocument)(text).pipe(
    Effect.mapError((error) => malformed("json", error.message)),
  );
  const parsed = yield* Schema.decodeUnknownEffect(skitConfigSchema, {
    onExcessProperty: "error",
    errors: "all",
  })(input).pipe(Effect.mapError((error) => malformed("json", error.message)));
  return yield* validateDescriptorEffect(
    {
      skit: 1,
      slug: parsed.slug,
      ...(parsed.sameAs ? { sameAs: parsed.sameAs } : {}),
      ...(parsed.author ? { author: parsed.author } : {}),
      skills: parsed.skills.map((skill) => ({
        ...skill,
        default_enabled: skill.default_enabled ?? true,
      })),
    },
    "json",
  );
});

export function parseSkillExample(text: string): SkillExampleManifest {
  return Schema.decodeUnknownSync(skillExampleSchema, { onExcessProperty: "error" })(
    parseYaml(text),
  );
}

export function hashParts(parts: Array<string | Uint8Array>): Digest {
  return `sha256:${createHash("sha256").update(encodeHashParts(parts)).digest("hex")}`;
}

export interface ProjectedSkillFile {
  bytes: Uint8Array;
  executable?: boolean;
}

/**
 * The files one contained Skill projects, keyed by their path inside the Skill. This is the
 * Skill as any consumer sees it: the Skill directory re-rooted, with shared mappings applied.
 */
export function projectSkillFiles(
  files: Array<{ path: string; bytes: Uint8Array; executable?: boolean }>,
  skillPath: string,
  shared: Array<{ from: string; to: string }> = [],
): Result.Result<Map<string, ProjectedSkillFile>, SharedTargetCollision> {
  const projected = new Map<string, ProjectedSkillFile>();
  const normalizedSkillPath = skillPath.normalize("NFC");
  for (const file of files) {
    const path = file.path.normalize("NFC");
    if (path.startsWith(`${normalizedSkillPath}/`))
      projected.set(path.slice(normalizedSkillPath.length + 1), file);
  }
  for (const mapping of shared)
    for (const file of files) {
      const path = file.path.normalize("NFC");
      const from = mapping.from.normalize("NFC");
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      const suffix = path === from ? "" : path.slice(from.length + 1);
      const target = (suffix ? `${mapping.to}/${suffix}` : mapping.to).normalize("NFC");
      if (projected.has(target)) return Result.fail(new SharedTargetCollision({ target }));
      projected.set(target, file);
    }
  return Result.succeed(projected);
}

/** A Release's file paths, NFC-normalised and sorted so every directory is one contiguous range. */
export interface ProjectionIndex {
  readonly paths: readonly string[];
  readonly sizes: readonly number[];
}

export function projectionIndex(
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
): ProjectionIndex {
  const sorted = files
    .map((file) => ({ path: file.path.normalize("NFC"), size: file.bytes.byteLength }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { paths: sorted.map(({ path }) => path), sizes: sorted.map(({ size }) => size) };
}

/**
 * The entries and stored-archive bytes a Skill's projection would produce, counted without building
 * it: each entry costs its content, 76 bytes of ZIP headers and its name twice, plus a 22-byte end
 * record. Counting stops once `limit` is exceeded, so a projection that shared mappings expand
 * without bound is never walked in full.
 */
export function measureSkillProjection(
  index: ProjectionIndex,
  skillPath: string,
  shared: ReadonlyArray<{ from: string; to: string }>,
  limit: { readonly entries: number; readonly archiveBytes: number },
): { entries: number; archiveBytes: number } {
  const encoder = new TextEncoder();
  const measured = { entries: 0, archiveBytes: 22 };
  const exceeded = () =>
    measured.entries > limit.entries || measured.archiveBytes > limit.archiveBytes;
  const add = (name: string, position: number) => {
    measured.entries += 1;
    measured.archiveBytes += index.sizes[position]! + 76 + 2 * encoder.encode(name).byteLength;
  };
  const firstAtOrAfter = (path: string) => {
    let low = 0;
    let high = index.paths.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (index.paths[middle]! < path) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const within = (directory: string, target: (suffix: string) => string) => {
    const prefix = `${directory}/`;
    for (
      let position = firstAtOrAfter(prefix);
      position < index.paths.length && index.paths[position]!.startsWith(prefix) && !exceeded();
      position++
    )
      add(target(index.paths[position]!.slice(prefix.length)), position);
  };
  within(skillPath.normalize("NFC"), (suffix) => suffix);
  for (const mapping of shared) {
    if (exceeded()) break;
    const from = mapping.from.normalize("NFC");
    const exact = firstAtOrAfter(from);
    if (index.paths[exact] === from) add(mapping.to.normalize("NFC"), exact);
    within(from, (suffix) => `${mapping.to}/${suffix}`.normalize("NFC"));
  }
  return measured;
}

export function hashProjectedSkillFiles(
  files: Array<{ path: string; bytes: Uint8Array; executable?: boolean }>,
  skillPath: string,
  shared: Array<{ from: string; to: string }> = [],
): Result.Result<Digest, SharedTargetCollision | ProjectedPathCollision> {
  return Result.map(projectedSkillHashParts(files, skillPath, shared), hashParts);
}

/** Canonical digest inputs, separated so every runtime can supply its native SHA-256. */
export function projectedSkillHashParts(
  files: Array<{ path: string; bytes: Uint8Array; executable?: boolean }>,
  skillPath: string,
  shared: Array<{ from: string; to: string }> = [],
): Result.Result<Array<string | Uint8Array>, SharedTargetCollision | ProjectedPathCollision> {
  const projected = projectSkillFiles(files, skillPath, shared);
  if (Result.isFailure(projected)) return Result.fail(projected.failure);
  interface ProjectedNode {
    children: Map<string, ProjectedNode>;
    file?: { bytes: Uint8Array; executable?: boolean };
  }
  const root: ProjectedNode = { children: new Map() };
  for (const [path, file] of projected.success) {
    const segments = path.split("/");
    let node = root;
    for (const [index, segment] of segments.entries()) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      if (node.file || (index === segments.length - 1 && child.children.size > 0))
        return Result.fail(new ProjectedPathCollision({ path, kind: "file-or-directory" }));
      node = child;
    }
    if (node.file) return Result.fail(new ProjectedPathCollision({ path, kind: "file" }));
    node.file = file;
  }
  const parts: Array<string | Uint8Array> = [];
  function walk(node: ProjectedNode, parent = ""): void {
    for (const name of [...node.children.keys()].sort()) {
      const child = node.children.get(name)!;
      const path = parent ? `${parent}/${name}` : name;
      if (child.file) parts.push(path, child.file.executable ? "493" : "420", child.file.bytes);
      else walk(child, path);
    }
  }
  walk(root);
  return Result.succeed(parts);
}
