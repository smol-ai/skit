import { AuditOrigin, type AuditSkillV1Alpha4 } from "@smolai/skit-core/audit";
import { harnessLabel } from "@smolai/skit-core/harnesses";

type Confidence = AuditSkillV1Alpha4["provenance"]["confidence"];
const confidenceLabels = {
  exact: "Exact match",
  matched: "Inferred match",
  unknown: "Unknown",
} satisfies Record<Confidence, string>;
export const auditConfidenceLabel = (confidence: Confidence): string =>
  confidenceLabels[confidence];

/** Display labels are separate from group identity and ownership. */
export const auditOriginLabel = (origin: AuditOrigin): string =>
  AuditOrigin.match(origin, {
    PnpmPackage: ({ package: name, version }) => `pnpm | ${name}@${version}`,
    SkitManaged: () => "Managed by SKIT",
    SkitUnrecorded: () => "Managed by SKIT; missing from the Library",
    BundledSkills: ({ harness }) => `${harnessLabel(harness)} bundled skills`,
    SkillsSh: () => "skills.sh",
    Symlink: () => "Symbolic link",
    Unknown: () => "Source unavailable",
    Configuration: ({ harness }) => `${harnessLabel(harness)} configuration`,
    MarketplaceRegistry: ({ harness }) => `${harnessLabel(harness)} marketplace registry`,
    PluginRegistry: ({ harness }) => `${harnessLabel(harness)} plugin registry`,
    EnabledPluginSetting: ({ harness }) => `${harnessLabel(harness)} enabled plugins`,
    PluginCache: ({ harness }) => `${harnessLabel(harness)} plugin cache`,
  });

/** Tuple keys preserve all identity fields without depending on labels or object key order. */
export const auditOriginKey = (origin: AuditOrigin): string =>
  AuditOrigin.match(origin, {
    PnpmPackage: ({ _tag, package: name, version }) => JSON.stringify([_tag, name, version]),
    SkitManaged: ({ _tag }) => _tag,
    SkitUnrecorded: ({ _tag }) => _tag,
    BundledSkills: ({ _tag, harness }) => JSON.stringify([_tag, harness]),
    SkillsSh: ({ _tag }) => _tag,
    Symlink: ({ _tag }) => _tag,
    Unknown: ({ _tag }) => _tag,
    Configuration: ({ _tag, harness }) => JSON.stringify([_tag, harness]),
    MarketplaceRegistry: ({ _tag, harness }) => JSON.stringify([_tag, harness]),
    PluginRegistry: ({ _tag, harness }) => JSON.stringify([_tag, harness]),
    EnabledPluginSetting: ({ _tag, harness }) => JSON.stringify([_tag, harness]),
    PluginCache: ({ _tag, harness }) => JSON.stringify([_tag, harness]),
  });
