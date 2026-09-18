import { PortableLibraryInventory } from "@smolai/skit-core";
import { Schema } from "effect";
import { SetupResult } from "./setup-contract.js";

/** The refreshed Library view plus the complete read-only machine Skill observation. */
export const MachineInventoryResult = Schema.Struct({
  ...PortableLibraryInventory.fields,
  machine: Schema.Struct({
    repositoryRoots: SetupResult.fields.machineConfig.fields.repositoryRoots,
    repositoryDecisions: SetupResult.fields.machineConfig.fields.repositoryDecisions,
    scan: SetupResult.fields.scan,
    instances: SetupResult.fields.instances,
    brokenLinks: SetupResult.fields.brokenLinks,
    suppressed: SetupResult.fields.suppressed,
  }),
});
export type MachineInventoryResult = typeof MachineInventoryResult.Type;
