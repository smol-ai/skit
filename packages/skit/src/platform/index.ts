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
export type { AuthorIgnoreRepository } from "../artifact/plain-author-ignore.js";

export { LinkStat } from "./link-stat.js";

export { HomeBusy } from "./lock-failures.js";
export { PlatformErrorSchema } from "./error-schema.js";
