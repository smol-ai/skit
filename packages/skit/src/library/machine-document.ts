import { Schema } from "effect";
import { MachineId } from "./entity-ids.js";

export const MachineRepositoryDecision = Schema.declare(
  Schema.is(
    Schema.Struct({ path: Schema.String, status: Schema.Literals(["watched", "ignored"]) }),
  ),
);
export interface MachineRepositoryDecision extends Schema.Schema.Type<
  typeof MachineRepositoryDecision
> {}

/** Machine settings stored beside the Library. Unknown fields remain data. */
export const CurrentMachineDocument = Schema.declare(
  Schema.is(
    Schema.Struct({
      schemaVersion: Schema.Literal(5),
      machineId: Schema.optionalKey(MachineId),
      legacyMachineId: Schema.optionalKey(Schema.Json),
      displayName: Schema.optionalKey(Schema.NonEmptyString),
      discoveryRoots: Schema.Array(Schema.String),
      repositories: Schema.Array(MachineRepositoryDecision),
      repositoryDecisionsInitialized: Schema.Boolean,
    }),
  ),
);
export interface CurrentMachineDocument extends Schema.Schema.Type<typeof CurrentMachineDocument> {}
export const DiscoveryEvidence = Schema.Struct({
  discoveryRoots: Schema.Array(Schema.String),
  machineId: Schema.optionalKey(MachineId),
});
export interface DiscoveryEvidence extends Schema.Schema.Type<typeof DiscoveryEvidence> {}
export const emptyMachineDocument = (): CurrentMachineDocument => ({
  schemaVersion: 5,
  discoveryRoots: [],
  repositories: [],
  repositoryDecisionsInitialized: false,
});
