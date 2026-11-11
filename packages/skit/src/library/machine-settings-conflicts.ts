import { Schema } from "effect";

/** Why this machine's discovery settings cannot be restored from a setup. */
export const DiscoveryRestoreConflict = Schema.TaggedUnion({
  MachineChanged: {},
  DiscoveryFoldersChanged: {},
}).annotate({ identifier: "DiscoveryRestoreConflict" });
export type DiscoveryRestoreConflict = typeof DiscoveryRestoreConflict.Type;
