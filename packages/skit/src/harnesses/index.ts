/** Shared harness facts and caller-scoped probes. No CLI configuration or terminal output. */
export {
  detectInstalledHarnesses,
  harnessLabel,
  type InstalledHarnessOptions,
} from "./discovery.js";
export {
  probeHarness,
  probeRequestedHarnesses,
  HarnessProbeResult,
  HarnessProbeReport,
} from "./probe.js";
export { captureBounded } from "./probe-process.js";

export {
  HarnessName,
  type HarnessDocumentationSource,
  type SkillsDirectory,
  type HarnessProfile,
  type SkillsDirectoryOverrides,
} from "./contracts.js";
export { HarnessMetadataInvalid } from "./metadata-failures.js";
export {
  harnessProfile,
  harnessProfileIds,
  skillsDirectory,
  resolveSkillsDirectory,
  installSkillsDirectory,
} from "./catalog.js";
export { harnessDrivers } from "./drivers.js";
export { evaluateSkillFrontmatter } from "./frontmatter.js";
export { defaultSkillsRoot } from "./default-roots.js";
export { installDestinationHarnesses } from "./install-destinations.js";
export { readCodexSkills } from "./skill-listing/codex-discovery.js";
export { largeListingEntries, ListingBudget } from "./skill-listing/contracts.js";
export { readListingBudgets } from "./skill-listing/discovery.js";
export { readClaudeListingSnapshot } from "./skill-listing/claude.js";
export { readCodexListingBudget } from "./skill-listing/codex.js";
export { estimateCodexListing } from "./skill-listing/codex-allocation.js";
