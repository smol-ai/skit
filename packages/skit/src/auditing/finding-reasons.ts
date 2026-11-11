import { Schema } from "effect";
import { FrontmatterCompatibilityIssue } from "../harnesses/frontmatter.js";
import { OwnershipMarkerInvalidReason } from "../installed-skills/marker-failures.js";
import { SchemaFailure } from "../shared/schema-issue.js";
import { HarnessName } from "../harnesses/contracts.js";

export const CodexConfigurationIssue = Schema.TaggedUnion({
  UnsupportedLine: { line: Schema.Int },
  UnterminatedKey: { line: Schema.Int },
  InvalidValue: {
    line: Schema.Int,
    failure: Schema.Union([SchemaFailure, Schema.Defect()]).pipe(Schema.decodeTo(Schema.Unknown)),
  },
});

/** Audit findings retain the observed condition; frontends choose their explanations. */
export const AuditFindingReason = Schema.TaggedUnion({
  FrontmatterCompatibility: { harness: HarnessName, issue: FrontmatterCompatibilityIssue },
  AmbiguousLockfileAttribution: { skill: Schema.String },
  CodexConfigurationInvalid: {
    scope: Schema.Literals(["user", "project"]),
    issue: CodexConfigurationIssue,
  },
  EnabledPluginFilesMissing: {
    harness: Schema.Literals(["codex", "claude-code"]),
    plugin: Schema.String,
  },
  InstalledPluginFilesMissing: {
    harness: Schema.Literals(["codex", "claude-code"]),
    plugin: Schema.String,
  },
  EnabledPluginNotInstalled: {
    harness: Schema.Literals(["codex", "claude-code"]),
    plugin: Schema.String,
  },
  McpRegistrationUnsupported: { server: Schema.String },
  LibraryUnreadable: {},
  OwnershipMarkerInvalid: { reason: OwnershipMarkerInvalidReason },
  LibrarySkillMissing: {},
  McpRegistrationMissing: { server: Schema.String },
});
export type AuditFindingReason = typeof AuditFindingReason.Type;
