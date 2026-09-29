import { LibraryInventory } from "@smolai/skit-core";
import { Schema } from "effect";
import { SetupSkillInstance, SetupResult } from "./setup-contract.js";

/** The refreshed Library view plus the complete read-only machine Skill observation. */
export const MachineInventoryResult = Schema.Struct({
  ...LibraryInventory.fields,
  machine: Schema.Struct({
    repositoryRoots: SetupResult.fields.machineConfig.fields.repositoryRoots,
    repositoryDecisions: SetupResult.fields.machineConfig.fields.repositoryDecisions,
    scan: SetupResult.fields.scan,
    instances: Schema.Array(
      Schema.Struct({
        ...SetupSkillInstance.fields,
        skill_md_modified_at: Schema.NullOr(Schema.String),
      }),
    ),
    brokenLinks: SetupResult.fields.brokenLinks,
    suppressed: SetupResult.fields.suppressed,
  }),
});
export type MachineInventoryResult = typeof MachineInventoryResult.Type;
