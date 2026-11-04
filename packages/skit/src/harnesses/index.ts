/** Shared harness facts and caller-scoped probes. No CLI configuration or terminal output. */
export {
  detectInstalledHarnesses,
  harnessLabel,
  type InstalledHarnessOptions,
} from "./discovery.js";
export {
  probeHarness,
  probeHarnesses,
  probeRequestedHarnesses,
  HarnessProbeResult,
  HarnessProbeReport,
  type HarnessProbeOptions,
} from "./probe.js";
export { captureBounded, type BoundedCapture } from "./probe-process.js";
export { UnknownHarness } from "./probe-failures.js";
