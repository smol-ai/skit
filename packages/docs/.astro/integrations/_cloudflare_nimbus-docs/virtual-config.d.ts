declare module "virtual:nimbus/config" {
  import type { NimbusConfig, VersionAlternatesTable } from "@cloudflare/nimbus-docs/types";
  export const config: NimbusConfig;
  /** Build-time list of indexable collection names. See `getIndexedEntries()`. */
  export const indexedCollections: readonly string[];
  /** Build-time cross-version alternates table. See `getVersionAlternates()`. */
  export const versionAlternates: VersionAlternatesTable;
}
