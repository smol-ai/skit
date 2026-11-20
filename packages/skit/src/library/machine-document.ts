import { Schema } from "effect";
import { MachineId } from "./entity-ids.js";

const MachineRepositoryDecisionShape = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["watched", "ignored"]),
});
export const MachineRepositoryDecision = Schema.declare(Schema.is(MachineRepositoryDecisionShape));
export interface MachineRepositoryDecision extends Schema.Schema.Type<
  typeof MachineRepositoryDecision
> {}

/** Machine settings shape; the store uses the struct to enforce declared fields recursively. */
export const MachineDocumentShape = Schema.Struct({
  schemaVersion: Schema.Literal(5),
  machineId: Schema.optionalKey(MachineId),
  legacyMachineId: Schema.optionalKey(Schema.Json),
  displayName: Schema.optionalKey(Schema.NonEmptyString),
  discoveryRoots: Schema.Array(Schema.String),
  repositories: Schema.Array(MachineRepositoryDecisionShape),
  repositoryDecisionsInitialized: Schema.Boolean,
});
export const CurrentMachineDocument = Schema.declare(Schema.is(MachineDocumentShape));
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
