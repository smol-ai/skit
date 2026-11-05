/** Device runtime adapters and configuration. State owners keep their stores and writers private. */
export {
  SkitConfiguration,
  resolveSkitConfiguration,
  configurationForHome,
  skitConfigurationLayer,
  type ResolvedSkitConfiguration,
} from "./configuration.js";
export { skitLayer, type SkitServices } from "./layer.js";
export { SourceProcess, type SourceProcessResult } from "./source-process.js";
export { pathIsWithin } from "./path-identity.js";
export type { TreeRequirements } from "./tree-requirements.js";
