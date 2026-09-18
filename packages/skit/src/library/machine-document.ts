import { Schema, SchemaGetter } from "effect";
import {
  LegacyMachineId,
  MachineId,
  migratedMachineId,
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

/** One current read shape. V1 has no identity or display name to recover. */
export const CurrentMachineDocument = Schema.Struct({
  schemaVersion: Schema.Literal(4),
  machineId: Schema.optionalKey(MachineId),
  legacyMachineId: Schema.optionalKey(LegacyMachineId),
  displayName: Schema.optionalKey(Schema.NonEmptyString),
  discoveryRoots: Schema.Array(Schema.String),
  repositories: Schema.Array(MachineRepositoryDecision),
  repositoryDecisionsInitialized: Schema.Boolean,
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
      schemaVersion: 4 as const,
      discoveryRoots: document.repositoryRoots ?? [],
      repositories: [],
      repositoryDecisionsInitialized: false,
    })),
  ),
);

const fromV2 = MachineDocumentV2.pipe(
  Schema.decodeTo(
    CurrentMachineDocument,
    decodeOnly((document) => ({
      schemaVersion: 4 as const,
      machineId: migratedMachineId(document.machineId, document.machineId),
      legacyMachineId: document.machineId,
      ...(document.displayName === undefined ? {} : { displayName: document.displayName }),
      discoveryRoots: document.repositoryRoots ?? [],
      repositories: [],
      repositoryDecisionsInitialized: false,
    })),
  ),
);

const fromV3 = MachineDocumentV3.pipe(
  Schema.decodeTo(
    CurrentMachineDocument,
    decodeOnly((document) => ({
      schemaVersion: 4 as const,
      machineId: document.machineId,
      ...(document.displayName === undefined ? {} : { displayName: document.displayName }),
      discoveryRoots: document.repositoryRoots ?? [],
      repositories: [],
      repositoryDecisionsInitialized: false,
    })),
  ),
);

const fromV4 = MachineDocumentV4.pipe(
  Schema.decodeTo(
    CurrentMachineDocument,
    decodeOnly((document) => ({
      ...document,
      schemaVersion: 4 as const,
      repositoryDecisionsInitialized: true,
    })),
  ),
);

export const MachineDocument = Schema.Union([fromV4, fromV3, fromV2, fromV1]);
export const MachineDocumentJson = Schema.fromJsonString(MachineDocument);

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
