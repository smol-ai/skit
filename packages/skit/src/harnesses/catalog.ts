import { join, resolve } from "node:path";
import type { HarnessName } from "../contracts.js";
import {
  defineHarnessProfile,
  type HarnessProfile,
  type HarnessRoot,
  type HarnessRootContext,
} from "./contracts.js";
import {
  CODEX_SKILL_METADATA_CONTRACTS,
  CODEX_SKILL_METADATA_SOURCES,
} from "./codex-skill-metadata.js";

const VERIFIED_AT = "2026-08-25";
const NAME_CONSTRAINTS = [
  { kind: "length", min: 1, max: 64 },
  { kind: "pattern", value: "^[a-z0-9]+(-[a-z0-9]+)*$" },
  { kind: "directory-name" },
] as const;
const DESCRIPTION_CONSTRAINTS = [{ kind: "length", min: 1, max: 1024 }] as const;
const STANDARD_SOURCE = {
  id: "agent-skills-spec",
  kind: "standard",
  title: "Agent Skills specification",
  url: "https://agentskills.io/specification",
  verifiedAt: VERIFIED_AT,
} as const;
const SPEC_PORTABLE_FIELDS = [
  {
    name: "license",
    support: "optional",
    type: "string",
    semantics: "Portable license metadata",
    sourceIds: ["agent-skills-spec"],
  },
  {
    name: "compatibility",
    support: "optional",
    type: "string",
    semantics: "Portable environment requirements",
    constraints: [{ kind: "length", min: 1, max: 500 }],
    sourceIds: ["agent-skills-spec"],
  },
] as const;
const OPENCODE_V1_FIELDS = [
  {
    name: "name",
    support: "required",
    type: "string",
    semantics: "Skill identifier",
    constraints: NAME_CONSTRAINTS,
    sourceIds: ["opencode-v1-skills"],
  },
  {
    name: "description",
    support: "required",
    type: "string",
    semantics: "Discovery summary",
    constraints: DESCRIPTION_CONSTRAINTS,
    sourceIds: ["opencode-v1-skills"],
  },
  {
    name: "license",
    support: "optional",
    type: "string",
    semantics: "License name or bundled file reference",
    sourceIds: ["opencode-v1-skills"],
  },
  {
    name: "compatibility",
    support: "optional",
    type: "string",
    semantics: "Environment requirements",
    constraints: [{ kind: "length", min: 1, max: 500 }],
    sourceIds: ["opencode-v1-skills"],
  },
  {
    name: "metadata",
    support: "optional",
    type: "string-map",
    semantics: "Portable extension metadata",
    sourceIds: ["opencode-v1-skills"],
  },
] as const;

export const harnessProfiles = {
  codex: defineHarnessProfile({
    id: "codex",
    skillListing: {
      fraction: 0.02,
      fallbackCharacters: 8000,
      descriptionCap: 1024,
      sourceIds: ["openai-codex-skills"],
    },
    profile: { id: "skit/harness/codex", version: "2026-08-25", verifiedAt: VERIFIED_AT },
    roots: [
      {
        id: "codex-global-native",
        base: "home",
        path: ".codex/skills",
        scope: "global",
        role: "native",
        readable: true,
        writable: false,
        evidence: "documented",
      },
      {
        id: "codex-global-shared",
        base: "home",
        path: ".agents/skills",
        scope: "global",
        role: "compatibility",
        readable: true,
        writable: true,
        evidence: "observed",
      },
      {
        id: "codex-project-agents",
        base: "repository",
        path: ".agents/skills",
        scope: "project",
        role: "compatibility",
        readable: true,
        writable: true,
        evidence: "observed",
      },
      {
        id: "codex-project-codex",
        base: "repository",
        path: ".codex/skills",
        scope: "project",
        role: "native",
        readable: true,
        writable: false,
        evidence: "documented",
      },
    ],
    documentation: [
      STANDARD_SOURCE,
      {
        id: "openai-codex-skills",
        kind: "first-party-docs",
        title: "Codex: Agent Skills",
        url: "https://learn.chatgpt.com/docs/build-skills",
        verifiedAt: "2026-08-31",
      },
      ...CODEX_SKILL_METADATA_SOURCES,
    ],
    frontmatter: [
      {
        id: "skit/frontmatter/codex/2026-08-25",
        variant: "current",
        default: true,
        frontmatter: "required",
        unknownFields: "unknown",
        sourceIds: ["openai-codex-skills"],
        fields: [
          {
            name: "name",
            support: "required",
            type: "string",
            semantics: "Skill name",
            sourceIds: ["openai-codex-skills"],
          },
          {
            name: "description",
            support: "required",
            type: "string",
            semantics: "Discovery summary",
            sourceIds: ["openai-codex-skills"],
          },
          ...SPEC_PORTABLE_FIELDS.map((field) => ({ ...field, support: "unknown" as const })),
          {
            name: "metadata",
            support: "unknown",
            type: "string-map",
            semantics: "Agent Skills portable extension metadata",
            sourceIds: ["agent-skills-spec", "openai-codex-skills"],
          },
        ],
      },
    ],
    skillMetadata: CODEX_SKILL_METADATA_CONTRACTS,
    projection: {
      globalTarget: "codex-global-shared",
      projectTarget: "codex-project-agents",
      strategy: "copy",
    },
  }),
  "claude-code": defineHarnessProfile({
    id: "claude-code",
    skillListing: {
      fraction: 0.01,
      contextConversion: {
        charactersPerToken: 4,
        fallbackContextWindow: 200000,
        clientVersion: "2.1.292",
      },
      fallbackCharacters: 8000,
      descriptionCap: 1536,
      sourceIds: ["claude-code-skills"],
    },
    profile: { id: "skit/harness/claude-code", version: "2026-08-25", verifiedAt: VERIFIED_AT },
    roots: [
      {
        id: "claude-global-native",
        base: "home",
        path: ".claude/skills",
        scope: "global",
        role: "native",
        readable: true,
        writable: true,
        evidence: "documented",
      },
      {
        id: "claude-project-native",
        base: "repository",
        path: ".claude/skills",
        scope: "project",
        role: "native",
        readable: true,
        writable: true,
        evidence: "documented",
      },
      {
        id: "claude-project-agents",
        base: "repository",
        path: ".agents/skills",
        scope: "project",
        role: "compatibility",
        readable: true,
        writable: false,
        evidence: "observed",
      },
      // Claude documents project-level `.agents/skills` compatibility, but not a global
      // `~/.agents/skills` root. Keep that absence explicit instead of inferring symmetry.
    ],
    documentation: [
      STANDARD_SOURCE,
      {
        id: "claude-code-skills",
        kind: "first-party-docs",
        title: "Extend Claude with skills",
        url: "https://code.claude.com/docs/en/skills",
        verifiedAt: VERIFIED_AT,
      },
    ],
    frontmatter: [
      {
        id: "skit/frontmatter/claude-code/2026-08-25",
        variant: "current",
        default: true,
        frontmatter: "optional",
        unknownFields: "unknown",
        sourceIds: ["claude-code-skills"],
        fields: [
          {
            name: "name",
            support: "optional",
            type: "string",
            semantics: "Display name; defaults to directory",
            sourceIds: ["claude-code-skills"],
          },
          {
            name: "description",
            support: "optional",
            type: "string",
            semantics: "Discovery summary; defaults to first body paragraph",
            sourceIds: ["claude-code-skills"],
          },
          ...SPEC_PORTABLE_FIELDS,
          {
            name: "metadata",
            support: "optional",
            type: "object",
            semantics: "Free-form YAML metadata map; non-map values are dropped",
            invalidValue: "ignored",
            sourceIds: ["claude-code-skills"],
          },
          ...["when_to_use", "argument-hint", "model", "agent", "shell"].map((name) => ({
            name,
            support: "optional" as const,
            type: "string" as const,
            semantics: "Claude Code skill configuration",
            sourceIds: ["claude-code-skills"],
          })),
          ...["arguments", "allowed-tools", "disallowed-tools", "paths"].map((name) => ({
            name,
            support: "optional" as const,
            type: "string-list" as const,
            semantics: "Claude Code list configuration",
            sourceIds: ["claude-code-skills"],
          })),
          ...["disable-model-invocation", "user-invocable", "background"].map((name) => ({
            name,
            support: "optional" as const,
            type: "boolean-like" as const,
            semantics: "Claude Code invocation control",
            sourceIds: ["claude-code-skills"],
          })),
          {
            name: "context",
            support: "optional",
            type: "string",
            semantics: "Execution context",
            constraints: [{ kind: "enum", values: ["fork"] }],
            sourceIds: ["claude-code-skills"],
          },
          {
            name: "effort",
            support: "optional",
            type: "string",
            semantics: "Effort override",
            constraints: [{ kind: "enum", values: ["low", "medium", "high", "xhigh", "max"] }],
            sourceIds: ["claude-code-skills"],
          },
          {
            name: "hooks",
            support: "optional",
            type: "object",
            semantics: "Hooks registered when the skill is invoked",
            sourceIds: ["claude-code-skills"],
          },
        ],
      },
    ],
    projection: {
      globalTarget: "claude-global-native",
      projectTarget: "claude-project-native",
      strategy: "copy",
    },
  }),
  opencode: defineHarnessProfile({
    id: "opencode",
    profile: { id: "skit/harness/opencode", version: "2026-08-25", verifiedAt: VERIFIED_AT },
    roots: [
      {
        id: "opencode-global-native",
        base: "config",
        path: "opencode/skills",
        scope: "global",
        role: "native",
        readable: true,
        writable: false,
        evidence: "documented",
      },
      {
        id: "opencode-global-legacy",
        base: "home",
        path: ".config/opencode/skills",
        scope: "global",
        role: "compatibility",
        readable: true,
        writable: true,
        evidence: "observed",
      },
      {
        id: "opencode-project-native",
        base: "repository",
        path: ".opencode/skills",
        scope: "project",
        role: "native",
        readable: true,
        writable: true,
        evidence: "documented",
      },
      {
        id: "opencode-project-agents",
        base: "repository",
        path: ".agents/skills",
        scope: "project",
        role: "compatibility",
        readable: true,
        writable: false,
        evidence: "documented",
      },
      {
        id: "opencode-project-claude",
        base: "repository",
        path: ".claude/skills",
        scope: "project",
        role: "compatibility",
        readable: true,
        writable: false,
        evidence: "documented",
      },
    ],
    documentation: [
      {
        id: "opencode-v1-skills",
        kind: "first-party-docs",
        title: "Agent Skills",
        url: "https://opencode.ai/docs/skills",
        verifiedAt: VERIFIED_AT,
      },
      {
        id: "opencode-v2-skills",
        kind: "first-party-docs",
        title: "Skills V2",
        url: "https://opencode.ai/v2/docs/skills",
        verifiedAt: VERIFIED_AT,
      },
    ],
    frontmatter: [
      {
        id: "skit/frontmatter/opencode/v1/2026-08-25",
        variant: "v1",
        default: true,
        frontmatter: "required",
        unknownFields: "ignored",
        sourceIds: ["opencode-v1-skills"],
        fields: OPENCODE_V1_FIELDS,
      },
      {
        id: "skit/frontmatter/opencode/v2/2026-08-25",
        variant: "v2",
        default: false,
        frontmatter: "optional",
        unknownFields: "unknown",
        sourceIds: ["opencode-v2-skills"],
        fields: [
          {
            name: "name",
            support: "optional",
            type: "string",
            semantics: "Display name; ID is path-derived",
            sourceIds: ["opencode-v2-skills"],
          },
          {
            name: "description",
            support: "optional",
            type: "string",
            semantics: "Model-facing discovery summary",
            sourceIds: ["opencode-v2-skills"],
          },
          {
            name: "slash",
            support: "optional",
            type: "boolean",
            semantics: "Interactive catalog visibility",
            sourceIds: ["opencode-v2-skills"],
          },
          {
            name: "metadata",
            support: "optional",
            type: "string-map",
            semantics: "Includes opencode/slash and opencode/autoinvoke extensions",
            sourceIds: ["opencode-v2-skills"],
          },
          {
            name: "license",
            support: "ignored",
            type: "string",
            semantics: "Accepted for portability but not interpreted",
            sourceIds: ["opencode-v2-skills"],
          },
          {
            name: "compatibility",
            support: "ignored",
            type: "string",
            semantics: "Accepted for portability but not interpreted",
            sourceIds: ["opencode-v2-skills"],
          },
        ],
      },
    ],
    projection: {
      globalTarget: "opencode-global-legacy",
      projectTarget: "opencode-project-native",
      strategy: "copy",
    },
  }),
  devin: defineHarnessProfile({
    id: "devin",
    profile: { id: "skit/harness/devin", version: "2026-09-11", verifiedAt: "2026-09-11" },
    roots: [
      // Devin CLI 3000.10.21 reports these locations via `devin skills paths`. SKIT writes the
      // dedicated Devin roots so its Bindings do not collide with Codex at `.agents/skills`.
      {
        id: "devin-global-native",
        base: "config",
        path: "devin/skills",
        scope: "global",
        role: "native",
        readable: true,
        writable: true,
        evidence: "observed",
      },
      {
        id: "devin-global-cognition",
        base: "config",
        path: "cognition/skills",
        scope: "global",
        role: "compatibility",
        readable: true,
        writable: false,
        evidence: "observed",
      },
      {
        id: "devin-global-agents",
        base: "home",
        path: ".agents/skills",
        scope: "global",
        role: "compatibility",
        readable: true,
        writable: false,
        evidence: "observed",
      },
      {
        id: "devin-project-native",
        base: "repository",
        path: ".devin/skills",
        scope: "project",
        role: "native",
        readable: true,
        writable: true,
        evidence: "documented",
      },
      ...[
        ".agents/skills",
        ".cognition/skills",
        ".github/skills",
        ".claude/skills",
        ".cursor/skills",
        ".codex/skills",
        ".windsurf/skills",
      ].map((path, index) => ({
        id: `devin-project-compat-${index}`,
        base: "repository" as const,
        path,
        scope: "project" as const,
        role: "compatibility" as const,
        readable: true,
        writable: false,
        evidence: "observed" as const,
      })),
    ],
    documentation: [
      STANDARD_SOURCE,
      {
        id: "devin-skills",
        kind: "first-party-docs",
        title: "Skills",
        url: "https://docs.devin.ai/product-guides/skills",
        verifiedAt: VERIFIED_AT,
      },
      {
        id: "devin-cli-skill-paths",
        kind: "observed",
        title: "Devin CLI 3000.10.21: devin skills paths",
        url: null,
        verifiedAt: "2026-09-11",
      },
    ],
    frontmatter: [
      {
        id: "skit/frontmatter/devin/2026-08-25",
        variant: "current",
        default: true,
        frontmatter: "optional",
        unknownFields: "unknown",
        sourceIds: ["devin-skills", "agent-skills-spec"],
        fields: [
          {
            name: "name",
            support: "optional",
            type: "string",
            semantics: "Skill name; defaults to directory",
            sourceIds: ["devin-skills"],
          },
          {
            name: "description",
            support: "optional",
            type: "string",
            semantics: "Skill-list summary",
            sourceIds: ["devin-skills"],
          },
          ...SPEC_PORTABLE_FIELDS,
          {
            name: "metadata",
            support: "optional",
            type: "string-map",
            semantics: "Portable extension metadata",
            sourceIds: ["agent-skills-spec"],
          },
          {
            name: "allowed-tools",
            support: "optional",
            type: "string-list",
            semantics: "Tools available while active",
            sourceIds: ["devin-skills"],
          },
          {
            name: "argument-hint",
            support: "optional",
            type: "string",
            semantics: "Expected argument hint",
            sourceIds: ["devin-skills"],
          },
          {
            name: "triggers",
            support: "optional",
            type: "string-list",
            semantics: "Permitted invokers",
            sourceIds: ["devin-skills"],
          },
        ],
      },
    ],
    projection: {
      globalTarget: "devin-global-native",
      projectTarget: "devin-project-native",
      strategy: "copy",
    },
  }),
} as const satisfies Record<HarnessName, HarnessProfile>;

export function harnessProfile(harness: HarnessName): HarnessProfile {
  return harnessProfiles[harness];
}

export function hasHarnessProfile(id: string): id is HarnessName {
  return Object.hasOwn(harnessProfiles, id);
}

export function harnessProfileIds(): readonly HarnessName[] {
  return Object.values(harnessProfiles).map((profile) => profile.id);
}

export function harnessRoot(profile: HarnessProfile, id: string): HarnessRoot {
  const root = profile.roots.find((candidate) => candidate.id === id);
  if (!root) throw new Error(`Unknown root ${id} for ${profile.id}`);
  return root;
}

export function resolveHarnessRoot(root: HarnessRoot, context: HarnessRootContext): string {
  const base =
    root.base === "home"
      ? context.home
      : root.base === "config"
        ? context.configHome
        : context.repository;
  if (!base) throw new Error(`Repository root is required for ${root.id}`);
  return resolve(join(base, root.path));
}

export function projectionRoot(
  harness: HarnessName,
  scope: "global" | "project",
  context: HarnessRootContext,
): string | null {
  const profile = harnessProfile(harness);
  const id =
    scope === "global" ? profile.projection.globalTarget : profile.projection.projectTarget;
  return id ? resolveHarnessRoot(harnessRoot(profile, id), context) : null;
}
