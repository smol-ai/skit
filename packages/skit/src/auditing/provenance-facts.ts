import { Schema } from "effect";
import { HarnessName } from "../harnesses/contracts.js";

/** What established an audit entry's origin, independent of any frontend label. */
export const AuditOrigin = Schema.TaggedUnion({
  PnpmPackage: { package: Schema.String, version: Schema.String },
  SkitManaged: {},
  SkitUnrecorded: {},
  BundledSkills: { harness: Schema.Literal("codex") },
  SkillsSh: {},
  Symlink: {},
  Unknown: {},
  Configuration: { harness: HarnessName },
  MarketplaceRegistry: { harness: Schema.Literal("claude-code") },
  PluginRegistry: { harness: Schema.Literal("claude-code") },
  EnabledPluginSetting: { harness: Schema.Literal("claude-code") },
  PluginCache: { harness: Schema.Literal("codex") },
});
export type AuditOrigin = typeof AuditOrigin.Type;
