import { Schema, Struct } from "effect";
import {
  normalizeRegistryNamespace,
  normalizeRegistrySkitSlug,
} from "./distribution/registry-identity.js";
import { Digest, InvocationPolicy } from "./library/store/state-schema.js";

export const SKIT_DESCRIPTOR_VERSION = 1 as const;
export const SKILL_EXAMPLE_SCHEMA_VERSION = "skit.skill-example/v1" as const;

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const atMost = (length: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(length));
const url = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }),
);
const isoTimestamp = Schema.String.check(
  Schema.isPattern(
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:[12]\d|0[1-9]|3[01])[T ](?:0\d|1\d|2[0-3])(?::[0-5]\d){2}(?:\.\d{1,9})?(?:Z| ?[+-](?:0\d|1\d|2[0-3])(?::?[0-5]\d)?)$/u,
  ),
);

export const digestSchema = Digest;
export const safePathSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_024),
  Schema.makeFilter((value) => /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/.test(value), {
    message: "Path must be safe and relative",
  }),
  Schema.makeFilter((value) => !value.includes("\\") && !value.includes("\0"), {
    message: "Path must not contain backslashes or NUL bytes",
  }),
  Schema.makeFilter((value) => value === value.normalize("NFC"), {
    message: "Path must be NFC normalised",
  }),
);
export const kebabNameSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));
export const registryNamespaceSchema = Schema.String.check(
  Schema.makeFilter((value) => normalizeRegistryNamespace(value) === value, {
    message: "Namespace must be canonical",
  }),
);
export const registrySkitSlugSchema = Schema.String.check(
  Schema.makeFilter((value) => normalizeRegistrySkitSlug(value) === value, {
    message: "SKIT slug must be canonical",
  }),
);
export const registrySkitIdSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const parts = value.split("/");
      return (
        parts.length === 2 &&
        normalizeRegistryNamespace(parts[0]) === parts[0] &&
        normalizeRegistrySkitSlug(parts[1]) === parts[1]
      );
    },
    { message: "Registry SKIT id must contain a canonical Namespace and SKIT slug" },
  ),
);

export const sharedMappingSchema = Schema.Struct({ from: safePathSchema, to: safePathSchema });
export type SharedMapping = typeof sharedMappingSchema.Type;

export const skitValidationDiagnosticSchema = Schema.Struct({
  code: nonEmpty,
  severity: Schema.Literals(["error", "warning"]),
  path: Schema.optionalKey(safePathSchema),
  message: nonEmpty,
});

const triggerMode = Schema.Literals(["explicit", "implicit", "host_policy", "skill_dependency"]);
const mutationScope = Schema.Literals(["none", "workspace", "repository", "external_system"]);
const capability = Schema.Literals([
  "filesystem_read",
  "filesystem_write",
  "shell",
  "network",
  "mcp",
  "hooks",
]);

export const containedSkillSchema = Schema.Struct({
  name: kebabNameSchema,
  path: safePathSchema,
  source_updated_at: Schema.optionalKey(isoTimestamp),
  default_enabled: Schema.Boolean,
  shared: Schema.optionalKey(Schema.mutable(Schema.Array(sharedMappingSchema))),
  invocation: Schema.optionalKey(InvocationPolicy),
  trigger_modes: Schema.optionalKey(Schema.Array(triggerMode)),
  mutation_scopes: Schema.optionalKey(Schema.Array(mutationScope)),
  capabilities: Schema.optionalKey(Schema.mutable(Schema.Array(capability))),
  approval: Schema.optionalKey(Schema.Literals(["always", "on_request", "never"])),
  expected_outputs: Schema.optionalKey(Schema.Array(atMost(200))),
});
export type ContainedSkillDescriptor = typeof containedSkillSchema.Type;

const author = Schema.Struct({
  name: nonEmpty,
  sameAs: Schema.optionalKey(Schema.Array(url)),
});
const configSkill = containedSkillSchema
  .mapFields(Struct.omit(["source_updated_at"]))
  .pipe(Schema.fieldsAssign({ default_enabled: Schema.optionalKey(Schema.Boolean) }));

export const skitConfigSchema = Schema.Struct({
  $schema: Schema.optionalKey(nonEmpty),
  slug: kebabNameSchema,
  sameAs: Schema.optionalKey(Schema.Array(url)),
  author: Schema.optionalKey(author),
  skills: Schema.Array(configSkill).check(Schema.isMinLength(1)),
});

export const skillExampleSchema = Schema.Struct({
  schema_version: Schema.Literal(SKILL_EXAMPLE_SCHEMA_VERSION),
  id: kebabNameSchema,
  skill: kebabNameSchema,
  title: atMost(120),
  summary: Schema.optionalKey(atMost(500)),
  featured: Schema.optionalKey(Schema.Boolean),
  prompt: Schema.Struct({
    path: safePathSchema,
    provenance: Schema.Literals(["exact", "reconstructed", "synthetic"]),
  }),
  execution: Schema.Struct({
    isolation: Schema.Literals(["skill_only", "full_skit", "active_context"]),
    network: Schema.Literals(["disabled", "restricted", "enabled"]),
    fixtures: Schema.optionalKey(Schema.Array(safePathSchema)),
  }),
  checks: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: kebabNameSchema,
        kind: Schema.Literal("rubric"),
        criterion: atMost(500),
      }),
    ),
  ),
  screenshots: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: safePathSchema,
        role: Schema.Literals(["input", "process", "output", "comparison"]),
        alt: atMost(500),
        caption: Schema.optionalKey(atMost(500)),
      }),
    ),
  ),
  privacy: Schema.Struct({
    classification: Schema.Literals(["public_safe", "private"]),
    reviewed: Schema.Boolean,
  }),
});
export type SkillExampleManifest = typeof skillExampleSchema.Type;

const wireSkill = Schema.Struct({
  name: Schema.mutableKey(kebabNameSchema),
  path: Schema.mutableKey(safePathSchema),
  default_enabled: Schema.mutableKey(Schema.Boolean),
  shared: Schema.mutableKey(Schema.optional(Schema.mutable(Schema.Array(sharedMappingSchema)))),
});
export const skitDescriptorWireSchema = Schema.Struct({
  skit: Schema.mutableKey(Schema.Literal(SKIT_DESCRIPTOR_VERSION)),
  id: Schema.mutableKey(registrySkitIdSchema),
  slug: Schema.mutableKey(kebabNameSchema),
  sameAs: Schema.mutableKey(Schema.optional(Schema.mutable(Schema.Array(url)))),
  author: Schema.mutableKey(Schema.optional(author)),
  skills: Schema.mutableKey(Schema.mutable(Schema.Array(wireSkill)).check(Schema.isMinLength(1))),
});
export type SkitWireDescriptor = typeof skitDescriptorWireSchema.Type;
export const skitDescriptorSchema = Schema.Struct({
  skit: Schema.Literal(SKIT_DESCRIPTOR_VERSION),
  slug: kebabNameSchema,
  sameAs: Schema.optionalKey(Schema.Array(url)),
  author: Schema.optionalKey(author),
  skills: Schema.Array(containedSkillSchema).check(Schema.isMinLength(1)),
  capabilities: Schema.optionalKey(
    Schema.Struct({
      executables: Schema.optionalKey(Schema.Array(safePathSchema)),
      hooks: Schema.optionalKey(Schema.Array(safePathSchema)),
      mcp: Schema.optionalKey(Schema.Array(safePathSchema)),
    }),
  ),
  compatibility: Schema.optionalKey(
    Schema.Struct({
      agents: Schema.optionalKey(Schema.Array(Schema.String)),
      operating_systems: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  dependencies: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["skit", "mcp", "executable"]),
        id: nonEmpty,
        version: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
export type SkitDescriptor = typeof skitDescriptorSchema.Type;
