import { Schema, SchemaGetter } from "effect";
import {
  LegacyMachineId,
  MachineId,
  migratedMachineId,
  OperationId,
  type LegacyMachineId as LegacyMachineIdType,
  type MachineId as MachineIdType,
} from "./entity-ids.js";

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

export const MachineDocumentV4 = Schema.Struct({
  schemaVersion: Schema.Literal(4),
  machineId: MachineId,
  displayName: Schema.NonEmptyString,
  discoveryRoots: Schema.Array(Schema.String),
  repositories: Schema.Array(MachineRepositoryDecision),
});
export interface MachineDocumentV4 extends Schema.Schema.Type<typeof MachineDocumentV4> {}

/** V5 preserves discovery initialization independently of creating a machine identity. */
export const MachineDocumentV5 = Schema.Struct({
  ...MachineDocumentV4.fields,
  schemaVersion: Schema.Literal(5),
  repositoryDecisionsInitialized: Schema.Boolean,
});
export interface MachineDocumentV5 extends Schema.Schema.Type<typeof MachineDocumentV5> {}

/** The discovery folders, and the identity they were saved under, at one moment of a setup. */
export const DiscoveryEvidence = Schema.Struct({
  discoveryRoots: Schema.Array(Schema.String),
  machineId: Schema.optionalKey(MachineId),
});
export interface DiscoveryEvidence extends Schema.Schema.Type<typeof DiscoveryEvidence> {}

/** The discovery folders one setup changed: before, and what it saved. Undo restores `before`. */
export const MachineSettingsSetupRecord = Schema.Struct({
  operationId: OperationId,
  before: DiscoveryEvidence,
  expectedAfter: DiscoveryEvidence,
});
export interface MachineSettingsSetupRecord extends Schema.Schema.Type<
  typeof MachineSettingsSetupRecord
> {}

/**
 * V6 keeps the record of the setup that last saved discovery folders, so undo can restore them; an
 * older SKIT refuses the document instead of dropping it.
 */
export const MachineDocumentV6 = Schema.Struct({
  ...MachineDocumentV5.fields,
  schemaVersion: Schema.Literal(6),
  setups: Schema.Array(MachineSettingsSetupRecord),
});
export interface MachineDocumentV6 extends Schema.Schema.Type<typeof MachineDocumentV6> {}

/** V7 records completed setup inverses alongside the discovery folders they restored. */
export const MachineDocumentV7 = Schema.Struct({
  ...MachineDocumentV6.fields,
  schemaVersion: Schema.Literal(7),
  undoneSetups: Schema.Array(Schema.NonEmptyString),
});
export interface MachineDocumentV7 extends Schema.Schema.Type<typeof MachineDocumentV7> {}

/** One current read shape. V1 has no identity or display name to recover. */
export const CurrentMachineDocument = Schema.Struct({
  schemaVersion: Schema.Literal(7),
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
  encode: SchemaGetter.forbidden<Encoded, CurrentMachineDocumentEncoded>(
    () => "legacy machine documents are decode-only",
  ),
});

const fromV1 = MachineDocumentV1.pipe(
  Schema.decodeTo(
    CurrentMachineDocument,
    decodeOnly((document) => ({
      schemaVersion: 7 as const,
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
      schemaVersion: 7 as const,
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
      schemaVersion: 7 as const,
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
      schemaVersion: 7 as const,
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
      schemaVersion: 7 as const,
      setups: [],
      undoneSetups: [],
    })),
  ),
);

const fromV6 = MachineDocumentV6.pipe(
  Schema.decodeTo(
    CurrentMachineDocument,
    decodeOnly((document) => ({ ...document, schemaVersion: 7 as const, undoneSetups: [] })),
  ),
);

export const MachineDocument = Schema.Union([
  MachineDocumentV7,
  fromV6,
  fromV5,
  fromV4,
  fromV3,
  fromV2,
  fromV1,
]);
export const MachineDocumentJson = Schema.fromJsonString(MachineDocument);

/** What a machine reads as before it has written `machine.json`. */
export const emptyMachineDocument = (): CurrentMachineDocument => ({
  schemaVersion: 7,
  undoneSetups: [],
  discoveryRoots: [],
  repositories: [],
  repositoryDecisionsInitialized: false,
  setups: [],
});

export const currentMachineDocument = (
  fields: Omit<MachineDocumentV7, "schemaVersion">,
): MachineDocumentV7 => ({ ...fields, schemaVersion: 7 });

export const machineDocumentIdentity = (
  document: CurrentMachineDocument,
):
  | { readonly machineId: MachineIdType; readonly legacyMachineId?: LegacyMachineIdType }
  | undefined =>
  document.machineId === undefined
    ? undefined
    : {
        machineId: document.machineId,
        ...(document.legacyMachineId === undefined
          ? {}
          : { legacyMachineId: document.legacyMachineId }),
      };
