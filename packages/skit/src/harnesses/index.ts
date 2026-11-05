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
