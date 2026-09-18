// The SKIT Descriptor and Skill projection rules: parsing, normalisation and content hashing.
// Everything here is pure computation over strings and bytes so the Registry Worker can share
// it with the CLI. Filesystem-backed workflows over a SKIT directory live in skit.ts.

import { Effect, Result, Schema } from "effect";
// Hashing is deterministic computation, not IO, so it stays on node:crypto.
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
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
  const parsed = Schema.decodeUnknownResult(skitDescriptorSchema, {
    onExcessProperty: "error",
    errors: "all",
  })(input);
  if (Result.isFailure(parsed)) return yield* malformed(format, parsed.failure.message);
  const skills = yield* normalizeSkillsEffect(parsed.success.skills);
  const descriptor: SkitDescriptor = { ...parsed.success, skills };
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
  const parsed = Schema.decodeUnknownResult(skitConfigSchema, {
    onExcessProperty: "error",
    errors: "all",
  })(input);
  if (Result.isFailure(parsed)) return yield* malformed("json", parsed.failure.message);
  return yield* validateDescriptorEffect(
    {
      skit: 1,
      slug: parsed.success.slug,
      ...(parsed.success.sameAs ? { sameAs: parsed.success.sameAs } : {}),
      ...(parsed.success.author ? { author: parsed.success.author } : {}),
      skills: parsed.success.skills.map((skill) => ({
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
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    hash.update(String(bytes.length));
    hash.update(":");
    hash.update(bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
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
): Map<string, ProjectedSkillFile> {
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
      if (projected.has(target)) throw new SharedTargetCollision({ target });
      projected.set(target, file);
    }
  return projected;
}

export function hashProjectedSkillFiles(
  files: Array<{ path: string; bytes: Uint8Array; executable?: boolean }>,
  skillPath: string,
  shared: Array<{ from: string; to: string }> = [],
): Digest {
  return hashParts(projectedSkillHashParts(files, skillPath, shared));
}

/** Canonical digest inputs, separated so every runtime can supply its native SHA-256. */
export function projectedSkillHashParts(
  files: Array<{ path: string; bytes: Uint8Array; executable?: boolean }>,
  skillPath: string,
  shared: Array<{ from: string; to: string }> = [],
): Array<string | Uint8Array> {
  const projected = projectSkillFiles(files, skillPath, shared);
  interface ProjectedNode {
    children: Map<string, ProjectedNode>;
    file?: { bytes: Uint8Array; executable?: boolean };
  }
  const root: ProjectedNode = { children: new Map() };
  for (const [path, file] of projected) {
    const segments = path.split("/");
    let node = root;
    for (const [index, segment] of segments.entries()) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      if (node.file || (index === segments.length - 1 && child.children.size > 0))
        throw new ProjectedPathCollision({ path, kind: "file-or-directory" });
      node = child;
    }
    if (node.file) throw new ProjectedPathCollision({ path, kind: "file" });
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
  return parts;
}
