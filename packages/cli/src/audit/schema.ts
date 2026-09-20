import { FrontmatterCompatibilityResult, HarnessName, SkillAudit } from "@smolai/skit-core";
import { Schema } from "effect";

const StringArray = Schema.Array(Schema.String);
const AuditScope = Schema.Literals(["user", "project", "legacy"]);
const AuditKind = Schema.Literals(["skill", "rule", "plugin", "mcp-server", "marketplace"]);
export type AuditKind = typeof AuditKind.Type;

const AuditDocumentation = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["first-party-docs", "first-party-source", "standard", "observed"]),
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
  verifiedAt: Schema.String,
});

const AuditProvenance = Schema.Struct({
  confidence: Schema.Literals(["exact", "matched", "unknown"]),
  source: Schema.NullOr(Schema.String),
  evidence: Schema.Union([Schema.String, StringArray]),
  collectionId: Schema.optionalKey(Schema.String),
  parentPlugin: Schema.optionalKey(Schema.String),
  skillId: Schema.optionalKey(Schema.String),
  expectedHash: Schema.optionalKey(Schema.String),
  transactionId: Schema.optionalKey(Schema.String),
});

export const AuditObservation = Schema.Struct({
  kind: AuditKind,
  name: Schema.String,
  harnesses: Schema.Array(HarnessName),
  role: Schema.optionalKey(Schema.Literals(["native", "compatibility"])),
  scope: AuditScope,
  path: Schema.NullOr(Schema.String),
  canonicalPath: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.NullOr(Schema.String)),
  mcp: Schema.optionalKey(
    Schema.Struct({
      transport: Schema.Literals(["stdio", "http", "sse", "unknown"]),
      command: Schema.optionalKey(Schema.String),
      args: StringArray,
      cwd: Schema.optionalKey(Schema.String),
      url: Schema.optionalKey(Schema.String),
    }),
  ),
  installed: Schema.optionalKey(Schema.Boolean),
  enabled: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  active: Schema.optionalKey(Schema.Boolean),
  aliases: Schema.optionalKey(StringArray),
  provenance: Schema.mutableKey(AuditProvenance),
  staticAudit: Schema.optionalKey(SkillAudit),
  frontmatterCompatibility: Schema.optionalKey(Schema.Array(FrontmatterCompatibilityResult)),
});
export type AuditObservation = typeof AuditObservation.Type;

export const AuditFinding = Schema.Struct({
  severity: Schema.Literals(["warning", "error"]),
  code: Schema.String,
  subject: Schema.String,
  problem: Schema.String,
  locations: StringArray,
  details: Schema.Record(Schema.String, Schema.Unknown),
});
export type AuditFinding = typeof AuditFinding.Type;

const AuditProbe = Schema.Struct({
  harness: Schema.String,
  status: Schema.Literals(["ok", "failed"]),
  observed: Schema.optionalKey(
    Schema.Struct({
      plugins: Schema.optionalKey(Schema.Number),
      mcpServers: Schema.optionalKey(Schema.Number),
    }),
  ),
  reason: Schema.optionalKey(Schema.String),
});

export const AuditReport = Schema.Struct({
  generatedAt: Schema.String,
  home: Schema.String,
  cwd: Schema.String,
  coverage: Schema.Struct({
    supported: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        profileId: Schema.String,
        version: Schema.String,
        frontmatterContracts: StringArray,
        skillMetadataContracts: StringArray,
        documentation: Schema.Array(AuditDocumentation),
      }),
    ),
    deferred: StringArray,
  }),
  observations: Schema.Array(AuditObservation),
  findings: Schema.Array(AuditFinding),
  probes: Schema.Array(AuditProbe),
  summary: Schema.Struct({ capabilities: Schema.Number, findings: Schema.Number }),
});
export type AuditReport = typeof AuditReport.Type;

const auditEntryFields = {
  id: Schema.String,
  name: Schema.String,
  harnessIds: Schema.Array(HarnessName),
  scope: AuditScope,
  location: Schema.NullOr(Schema.String),
  canonicalLocation: Schema.optionalKey(Schema.String),
  provenance: AuditProvenance,
};

export const AuditSkillV1Alpha4 = Schema.Struct({
  ...auditEntryFields,
  role: Schema.Literals(["native", "compatibility"]),
  aliases: StringArray,
  staticAudit: Schema.optionalKey(SkillAudit),
  frontmatterCompatibility: Schema.optionalKey(Schema.Array(FrontmatterCompatibilityResult)),
});
export type AuditSkillV1Alpha4 = typeof AuditSkillV1Alpha4.Type;

export const AuditPluginV1Alpha4 = Schema.Struct({
  ...auditEntryFields,
  installed: Schema.Boolean,
  enabled: Schema.NullOr(Schema.Boolean),
});
export type AuditPluginV1Alpha4 = typeof AuditPluginV1Alpha4.Type;

export const AuditMcpServerV1Alpha4 = Schema.Struct({
  ...auditEntryFields,
  enabled: Schema.NullOr(Schema.Boolean),
  active: Schema.Boolean,
  transport: Schema.Literals(["stdio", "http", "sse", "unknown"]),
  command: Schema.optionalKey(Schema.String),
  args: StringArray,
  cwd: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
});
export type AuditMcpServerV1Alpha4 = typeof AuditMcpServerV1Alpha4.Type;

export const AuditRuleV1Alpha4 = Schema.Struct(auditEntryFields);
export type AuditRuleV1Alpha4 = typeof AuditRuleV1Alpha4.Type;
export const AuditMarketplaceV1Alpha4 = Schema.Struct(auditEntryFields);
export type AuditMarketplaceV1Alpha4 = typeof AuditMarketplaceV1Alpha4.Type;
export type AuditEntryV1Alpha4 =
  | AuditSkillV1Alpha4
  | AuditPluginV1Alpha4
  | AuditMcpServerV1Alpha4
  | AuditRuleV1Alpha4
  | AuditMarketplaceV1Alpha4;

const AuditFindingV1Alpha4 = Schema.Struct({
  id: Schema.String,
  severity: Schema.Literals(["warning", "error"]),
  code: Schema.String,
  entryIds: StringArray,
  unresolvedSubject: Schema.NullOr(Schema.String),
  problem: Schema.String,
  locations: StringArray,
  details: Schema.Record(Schema.String, Schema.Unknown),
});

export const AuditReportV1Alpha4 = Schema.Struct({
  schemaVersion: Schema.Literal("v1alpha4"),
  generatedAt: Schema.String,
  roots: Schema.Struct({ home: Schema.String, cwd: Schema.String }),
  harnesses: Schema.Array(
    Schema.Struct({
      id: HarnessName,
      detected: Schema.Boolean,
      profileId: Schema.String,
      profileVersion: Schema.String,
      frontmatterContracts: StringArray,
      skillMetadataContracts: StringArray,
      documentation: Schema.Array(AuditDocumentation),
      entryIds: StringArray,
    }),
  ),
  skills: Schema.Array(AuditSkillV1Alpha4),
  plugins: Schema.Array(AuditPluginV1Alpha4),
  mcpServers: Schema.Array(AuditMcpServerV1Alpha4),
  rules: Schema.Array(AuditRuleV1Alpha4),
  marketplaces: Schema.Array(AuditMarketplaceV1Alpha4),
  findings: Schema.Array(AuditFindingV1Alpha4),
  probes: Schema.Array(
    Schema.Struct({
      harnessId: Schema.String,
      status: Schema.Literals(["ok", "failed"]),
      observed: Schema.optionalKey(
        Schema.Struct({
          plugins: Schema.optionalKey(Schema.Number),
          mcpServers: Schema.optionalKey(Schema.Number),
        }),
      ),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
  coverage: Schema.Struct({ deferredHarnessIds: StringArray }),
  summary: Schema.Struct({
    harnesses: Schema.Number,
    skills: Schema.Number,
    plugins: Schema.Number,
    mcpServers: Schema.Number,
    rules: Schema.Number,
    marketplaces: Schema.Number,
    findings: Schema.Number,
  }),
});
export type AuditReportV1Alpha4 = typeof AuditReportV1Alpha4.Type;
