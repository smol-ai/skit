import type { HarnessName } from "../contracts.js";

export type HarnessRootBase = "home" | "config" | "repository";
export type HarnessRootRole = "native" | "compatibility";
export type HarnessEvidence = "documented" | "observed" | "unknown";
export type FrontmatterValueType =
  | "string"
  | "boolean"
  | "boolean-like"
  | "string-list"
  | "string-map"
  | "object";
export type FrontmatterSupport = "required" | "optional" | "ignored" | "unsupported" | "unknown";

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
  id: string;
  variant: string;
  default: boolean;
  frontmatter: "required" | "optional";
  unknownFields: "ignored" | "unknown";
  sourceIds: readonly string[];
  fields: readonly HarnessFrontmatterField[];
}

export type SkillMetadataValueType =
  | "string"
  | "boolean"
  | "integer"
  | "string-list"
  | "object-list";
export type SkillMetadataRequiredness = "required" | "optional" | "conditional" | "unknown";

export interface HarnessSkillMetadataField {
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

export interface HarnessRoot {
  id: string;
  base: HarnessRootBase;
  path: string;
  scope: "global" | "project";
  role: HarnessRootRole;
  readable: boolean;
  writable: boolean;
  evidence: HarnessEvidence;
}

export interface HarnessProfile {
  id: HarnessName;
  profile: {
    id: `skit/harness/${string}`;
    version: string;
    verifiedAt: string;
  };
  roots: readonly HarnessRoot[];
  documentation: readonly HarnessDocumentationSource[];
  frontmatter: readonly HarnessFrontmatterContract[];
  skillMetadata?: readonly HarnessSkillMetadataContract[];
  projection: {
    globalTarget: string | null;
    projectTarget: string | null;
    strategy: "copy" | "symlink";
  };
}

export function defineHarnessProfile<const T extends HarnessProfile>(profile: T): T {
  return profile;
}

export interface HarnessRootContext {
  home: string;
  configHome: string;
  repository?: string;
}
