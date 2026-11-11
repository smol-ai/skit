import { Schema } from "effect";
export const HarnessName = Schema.Literals(["codex", "claude-code", "opencode", "devin"]);
export type HarnessName = typeof HarnessName.Type;

export type SkillsDirectoryRole = "native" | "compatibility";
type HarnessEvidence = "documented" | "observed" | "unknown";
export type FrontmatterValueType =
  | "string"
  | "boolean"
  | "boolean-like"
  | "string-list"
  | "string-map"
  | "object";
type FrontmatterSupport = "required" | "optional" | "ignored" | "unsupported" | "unknown";

export interface HarnessDocumentationSource {
  id: string;
  kind: "first-party-docs" | "first-party-source" | "standard" | "observed";
  title: string;
  url: string | null;
  verifiedAt: string;
}

export type FrontmatterConstraint =
  | { kind: "length"; min?: number; max?: number }
  | { kind: "pattern"; value: string }
  | { kind: "directory-name" }
  | { kind: "enum"; values: readonly string[] };

export interface HarnessFrontmatterField {
  name: string;
  support: FrontmatterSupport;
  type: FrontmatterValueType;
  semantics: string;
  constraints?: readonly FrontmatterConstraint[];
  invalidValue?: "error" | "ignored" | "unknown";
  sourceIds: readonly string[];
}

export interface HarnessFrontmatterContract {
  readonly harness: HarnessName;
  id: string;
  variant: string;
  frontmatter: "required" | "optional";
  unknownFields: "ignored" | "unknown";
  sourceIds: readonly string[];
  fields: readonly HarnessFrontmatterField[];
}

type SkillMetadataValueType = "string" | "boolean" | "integer" | "string-list" | "object-list";
type SkillMetadataRequiredness = "required" | "optional" | "conditional" | "unknown";

interface HarnessSkillMetadataField {
  path: string;
  requiredness: SkillMetadataRequiredness;
  type: SkillMetadataValueType;
  semantics: string;
  constraints?: readonly string[];
  evidence: "documented" | "first-party-source";
  sourceIds: readonly string[];
}

export interface HarnessSkillMetadataContract {
  id: string;
  variant: string;
  default: boolean;
  path: string;
  format: "yaml";
  consumer: "machine-or-harness";
  unknownFields: "ignored" | "unknown";
  sourceIds: readonly string[];
  fields: readonly HarnessSkillMetadataField[];
}

export type SkillsDirectory = {
  id: string;
  path: string;
  role: SkillsDirectoryRole;
  readable: boolean;
  writable: boolean;
  evidence: HarnessEvidence;
} & (
  | { readonly base: "home" | "config"; readonly scope: "global" }
  | { readonly base: "repository"; readonly scope: "project" }
);

export interface SkillListingContract {
  readonly fraction: number;
  readonly contextConversion?: {
    readonly charactersPerToken: number;
    readonly fallbackContextWindow: number;
    readonly clientVersion: string;
  };
  readonly fallbackCharacters: number | null;
  readonly descriptionCap: number;
  readonly sourceIds: readonly string[];
}

export interface HarnessProfile {
  readonly skillListing?: SkillListingContract;
  id: HarnessName;
  profile: {
    id: `skit/harness/${string}`;
    version: string;
    verifiedAt: string;
  };
  roots: Readonly<Record<string, SkillsDirectory>>;
  documentation: readonly HarnessDocumentationSource[];
  frontmatter: {
    readonly default: HarnessFrontmatterContract;
    readonly variants: Readonly<Record<string, HarnessFrontmatterContract>>;
  };
  skillMetadata?: readonly HarnessSkillMetadataContract[];
  installedSkill: {
    globalTarget: Extract<SkillsDirectory, { scope: "global" }> & { readonly writable: true };
    projectTarget: Extract<SkillsDirectory, { scope: "project" }> & { readonly writable: true };
    strategy: "copy" | "symlink";
  };
}

export function defineHarnessProfile<const T extends HarnessProfile>(profile: T): T {
  return profile;
}

/** Device-local skills directories that stand in for a Harness's own global roots. */
export type SkillsDirectoryOverrides = Partial<Record<HarnessName, readonly string[]>>;

export type SkillsDirectoryContext =
  | { readonly scope: "global"; readonly home: string; readonly configHome: string }
  | { readonly scope: "project"; readonly repository: string };
