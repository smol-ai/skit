import { Schema, SchemaGetter } from "effect";
import { LegacyMachineId, MachineId, migratedMachineId, OperationId } from "./entity-ids.js";

export const MachineRepositoryDecision = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["watched", "ignored"]),
});
export interface MachineRepositoryDecision extends Schema.Schema.Type<
  typeof MachineRepositoryDecision
> {}

const MachineDocumentV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  repositoryRoots: Schema.Array(Schema.String),
});

const MachineDocumentV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  machineId: LegacyMachineId,
  displayName: Schema.optionalKey(Schema.NonEmptyString),
  repositoryRoots: Schema.optionalKey(Schema.Array(Schema.String)),
});

const MachineDocumentV3 = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  machineId: MachineId,
  displayName: Schema.optionalKey(Schema.NonEmptyString),
  repositoryRoots: Schema.optionalKey(Schema.Array(Schema.String)),
});

const MachineDocumentV4 = Schema.Struct({
  schemaVersion: Schema.Literal(4),
  machineId: MachineId,
  displayName: Schema.NonEmptyString,
  discoveryRoots: Schema.Array(Schema.String),
  repositories: Schema.Array(MachineRepositoryDecision),
});

/** V5 preserves discovery initialization independently of creating a machine identity. */
const MachineDocumentV5 = Schema.Struct({
  ...MachineDocumentV4.fields,
  schemaVersion: Schema.Literal(5),
  repositoryDecisionsInitialized: Schema.Boolean,
});

/** The discovery folders, and the identity they were saved under, at one moment of a setup. */
export const DiscoveryEvidence = Schema.Struct({
  discoveryRoots: Schema.Array(Schema.String),
  machineId: Schema.optionalKey(MachineId),
});
export interface DiscoveryEvidence extends Schema.Schema.Type<typeof DiscoveryEvidence> {}

/** The discovery folders one setup changed: before, and what it saved. Undo restores `before`. */
const MachineSettingsSetupRecord = Schema.Struct({
  operationId: OperationId,
  before: DiscoveryEvidence,
  expectedAfter: DiscoveryEvidence,
});

/** V6 records setup discovery changes and their completed inverses together. */
export const MachineDocumentV6 = Schema.Struct({
  ...MachineDocumentV5.fields,
  schemaVersion: Schema.Literal(6),
  setups: Schema.Array(MachineSettingsSetupRecord),
  undoneSetups: Schema.Array(Schema.NonEmptyString),
});
export interface MachineDocumentV6 extends Schema.Schema.Type<typeof MachineDocumentV6> {}

/** One current read shape. V1 has no identity or display name to recover. */
export const CurrentMachineDocument = Schema.Struct({
  schemaVersion: Schema.Literal(6),
  undoneSetups: Schema.Array(Schema.NonEmptyString),
  machineId: Schema.optionalKey(MachineId),
  legacyMachineId: Schema.optionalKey(LegacyMachineId),
  displayName: Schema.optionalKey(Schema.NonEmptyString),
  discoveryRoots: Schema.Array(Schema.String),
  repositories: Schema.Array(MachineRepositoryDecision),
  repositoryDecisionsInitialized: Schema.Boolean,
  setups: Schema.Array(MachineSettingsSetupRecord),
});
export interface CurrentMachineDocument extends Schema.Schema.Type<typeof CurrentMachineDocument> {}
type CurrentMachineDocumentEncoded = typeof CurrentMachineDocument.Encoded;

const decodeOnly = <Encoded>(decode: (encoded: Encoded) => CurrentMachineDocumentEncoded) => ({
  decode: SchemaGetter.transform<CurrentMachineDocumentEncoded, Encoded>(decode),
  encode: SchemaGetter.forbiddenEncoding,
});

const fromV1 = MachineDocumentV1.pipe(
  Schema.decodeTo(
    CurrentMachineDocument,
    decodeOnly((document) => ({
      schemaVersion: 6 as const,
      discoveryRoots: document.repositoryRoots ?? [],
      repositories: [],
      repositoryDecisionsInitialized: false,
      setups: [],
      undoneSetups: [],
    })),
  ),
);

const fromV2 = MachineDocumentV2.pipe(
  Schema.decodeTo(
    CurrentMachineDocument,
    decodeOnly((document) => ({
      schemaVersion: 6 as const,
      machineId: migratedMachineId(document.machineId, document.machineId),
      legacyMachineId: document.machineId,
      ...(document.displayName === undefined ? {} : { displayName: document.displayName }),
      discoveryRoots: document.repositoryRoots ?? [],
      repositories: [],
      repositoryDecisionsInitialized: false,
      setups: [],
      undoneSetups: [],
    })),
  ),
);

const fromV3 = MachineDocumentV3.pipe(
  Schema.decodeTo(
    CurrentMachineDocument,
    decodeOnly((document) => ({
      schemaVersion: 6 as const,
      machineId: document.machineId,
      ...(document.displayName === undefined ? {} : { displayName: document.displayName }),
      discoveryRoots: document.repositoryRoots ?? [],
      repositories: [],
      repositoryDecisionsInitialized: false,
      setups: [],
      undoneSetups: [],
    })),
  ),
);

const fromV4 = MachineDocumentV4.pipe(
  Schema.decodeTo(
    CurrentMachineDocument,
    decodeOnly((document) => ({
      ...document,
      schemaVersion: 6 as const,
      repositoryDecisionsInitialized: true,
      setups: [],
      undoneSetups: [],
    })),
  ),
);

const fromV5 = MachineDocumentV5.pipe(
  Schema.decodeTo(
    CurrentMachineDocument,
    decodeOnly((document) => ({
      ...document,
      schemaVersion: 6 as const,
      setups: [],
      undoneSetups: [],
    })),
  ),
);

export const supportedMachineDocumentVersions: readonly number[] = [
  MachineDocumentV1,
  MachineDocumentV2,
  MachineDocumentV3,
  MachineDocumentV4,
  MachineDocumentV5,
  MachineDocumentV6,
].map((document) => document.fields.schemaVersion.literal);

export const MachineDocument = Schema.Union([
  MachineDocumentV6,
  fromV5,
  fromV4,
  fromV3,
  fromV2,
  fromV1,
]);
export const MachineDocumentJson = Schema.fromJsonString(MachineDocument);

/** What a machine reads as before it has written `machine.json`. */
export const emptyMachineDocument = (): CurrentMachineDocument => ({
  schemaVersion: 6,
  undoneSetups: [],
  discoveryRoots: [],
  repositories: [],
  repositoryDecisionsInitialized: false,
  setups: [],
});

export const currentMachineDocument = (
  fields: Omit<MachineDocumentV6, "schemaVersion">,
): MachineDocumentV6 => ({ ...fields, schemaVersion: 6 });
