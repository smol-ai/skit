import { createHash } from "node:crypto";
import { Schema } from "effect";
import { fromString, fromUUIDBytes, typeidUnboxed } from "typeid-js";

export const EntityIdPrefixes = {
  collection: "coll",
  skill: "skill",
  skillVersion: "skv",
  retainedCopy: "ret",
  acquisition: "acq",
  projection: "proj",
  machine: "mach",
  operation: "op",
  adoptionReceipt: "rcpt",
} as const;

const typeIdFilter = <const Prefix extends string>(prefix: Prefix) =>
  Schema.makeFilter(
    (value: string) => {
      try {
        fromString(value, prefix);
        return true;
      } catch {
        return false;
      }
    },
    { message: `Expected a canonical ${prefix} TypeID` },
  );

const entityId = <const Prefix extends string, const Brand extends string>(
  prefix: Prefix,
  brand: Brand,
) => Schema.String.check(typeIdFilter(prefix)).pipe(Schema.brand(brand));

export const CollectionId = entityId(EntityIdPrefixes.collection, "CollectionId");
export type CollectionId = typeof CollectionId.Type;
export const SkillId = entityId(EntityIdPrefixes.skill, "SkillId");
export type SkillId = typeof SkillId.Type;
export const SkillVersionId = entityId(EntityIdPrefixes.skillVersion, "SkillVersionId");
export type SkillVersionId = typeof SkillVersionId.Type;
export const RetainedCopyId = entityId(EntityIdPrefixes.retainedCopy, "RetainedCopyId");
export type RetainedCopyId = typeof RetainedCopyId.Type;
export const AcquisitionId = entityId(EntityIdPrefixes.acquisition, "AcquisitionId");
export type AcquisitionId = typeof AcquisitionId.Type;
export const ProjectionId = entityId(EntityIdPrefixes.projection, "ProjectionId");
export type ProjectionId = typeof ProjectionId.Type;
export const MachineId = entityId(EntityIdPrefixes.machine, "MachineId");
export type MachineId = typeof MachineId.Type;
export const OperationId = entityId(EntityIdPrefixes.operation, "OperationId");
export type OperationId = typeof OperationId.Type;
export const AdoptionReceiptId = entityId(EntityIdPrefixes.adoptionReceipt, "AdoptionReceiptId");
export type AdoptionReceiptId = typeof AdoptionReceiptId.Type;

export const makeCollectionId = (): CollectionId =>
  typeidUnboxed(EntityIdPrefixes.collection) as unknown as CollectionId;
export const makeSkillId = (): SkillId =>
  typeidUnboxed(EntityIdPrefixes.skill) as unknown as SkillId;
export const makeSkillVersionId = (): SkillVersionId =>
  typeidUnboxed(EntityIdPrefixes.skillVersion) as unknown as SkillVersionId;
export const makeRetainedCopyId = (): RetainedCopyId =>
  typeidUnboxed(EntityIdPrefixes.retainedCopy) as unknown as RetainedCopyId;
export const makeAcquisitionId = (): AcquisitionId =>
  typeidUnboxed(EntityIdPrefixes.acquisition) as unknown as AcquisitionId;
export const makeProjectionId = (): ProjectionId =>
  typeidUnboxed(EntityIdPrefixes.projection) as unknown as ProjectionId;
export const makeMachineId = (): MachineId =>
  typeidUnboxed(EntityIdPrefixes.machine) as unknown as MachineId;
export const makeOperationId = (): OperationId =>
  typeidUnboxed(EntityIdPrefixes.operation) as unknown as OperationId;

/** UUIDv7 identities read only from schema-v3 state and machine configuration. */
export const LegacyMachineId = Schema.String.check(Schema.isUUID(7)).pipe(
  Schema.brand("LegacyMachineId"),
);
export type LegacyMachineId = typeof LegacyMachineId.Type;
type MigratedEntity = keyof typeof EntityIdPrefixes;

const uuidBytes = (uuid: string): Uint8Array => {
  const hex = uuid.replaceAll("-", "");
  if (!/^[a-f0-9]{32}$/i.test(hex)) throw new Error(`Invalid UUID: ${uuid}`);
  return Uint8Array.from(hex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
};

const timestampBytes = (source: string | Date): Uint8Array => {
  if (typeof source === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-7/i.test(source))
    return uuidBytes(source).slice(0, 6);
  const milliseconds = BigInt(new Date(source).getTime());
  if (milliseconds < 0n || milliseconds > 0xffffffffffffn)
    throw new Error(`Timestamp outside UUIDv7 range: ${String(source)}`);
  return Uint8Array.from({ length: 6 }, (_, index) =>
    Number((milliseconds >> BigInt((5 - index) * 8)) & 0xffn),
  );
};

/** Domain-separated deterministic UUIDv7 TypeID for legacy UUID migrations. */
export const deterministicMigrationId = <Entity extends MigratedEntity>(
  entity: Entity,
  timestampSource: string | Date,
  seed: string,
): string => {
  const prefix = EntityIdPrefixes[entity];
  const hash = createHash("sha256").update(`skit/migration/v3->v4/${prefix}\0${seed}`).digest();
  const bytes = new Uint8Array(16);
  bytes.set(timestampBytes(timestampSource), 0);
  bytes.set(hash.subarray(0, 10), 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return fromUUIDBytes(prefix, bytes) as string;
};

export const migratedMachineId = (timestampSource: string, seed: string): MachineId =>
  deterministicMigrationId("machine", timestampSource, seed) as MachineId;
