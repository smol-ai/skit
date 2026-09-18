import type { LibraryInstallationConfiguration } from "../../library/installation-configuration.js";

/** Device paths and Source access needed to retain portable Collection snapshots. */
export interface RetentionOptions {
  readonly installation: LibraryInstallationConfiguration;
  readonly originalsPath: string;
}
