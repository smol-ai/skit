import { assert, it } from "@effect/vitest";
import { Schema } from "effect";
import { fromString, toUUID } from "typeid-js";
import {
  AcquisitionId,
  CollectionId,
  MachineId,
  OperationId,
  ProjectionId,
  AdoptionReceiptId,
  RetainedCopyId,
  SkillId,
  SkillVersionId,
  deterministicMigrationId,
  makeCollectionId,
} from "../src/library/entity-ids.js";

it("generates and strictly validates namespaced entity TypeIDs", () => {
  const id = makeCollectionId();
  assert.ok(id.startsWith("coll_"));
  assert.strictEqual(Schema.is(CollectionId)(id), true);
  assert.strictEqual(Schema.is(SkillId)(id), false);
  assert.strictEqual(Schema.is(CollectionId)(id.toUpperCase()), false);
  assert.doesNotThrow(() => fromString(id, "coll"));
});

it("derives byte-stable, domain-separated UUIDv7 TypeIDs", () => {
  const source = "0195d2f0-7c00-7000-8000-000000000001";
  const seed = "github:fixture/skills\0review";
  const first = deterministicMigrationId("skill", source, seed);
  assert.strictEqual(first, deterministicMigrationId("skill", source, seed));
  const ids = {
    collection: deterministicMigrationId("collection", source, seed),
    skill: first,
    version: deterministicMigrationId("skillVersion", source, seed),
    retained: deterministicMigrationId("retainedCopy", source, seed),
    acquisition: deterministicMigrationId("acquisition", source, seed),
    projection: deterministicMigrationId("projection", source, seed),
    machine: deterministicMigrationId("machine", source, seed),
    operation: deterministicMigrationId("operation", source, seed),
    receipt: deterministicMigrationId("adoptionReceipt", source, seed),
  };
  assert.strictEqual(new Set(Object.values(ids)).size, Object.values(ids).length);
  assert.strictEqual(Schema.is(CollectionId)(ids.collection), true);
  assert.strictEqual(Schema.is(SkillId)(ids.skill), true);
  assert.strictEqual(Schema.is(SkillVersionId)(ids.version), true);
  assert.strictEqual(Schema.is(RetainedCopyId)(ids.retained), true);
  assert.strictEqual(Schema.is(AcquisitionId)(ids.acquisition), true);
  assert.strictEqual(Schema.is(ProjectionId)(ids.projection), true);
  assert.strictEqual(Schema.is(MachineId)(ids.machine), true);
  assert.strictEqual(Schema.is(OperationId)(ids.operation), true);
  assert.strictEqual(Schema.is(AdoptionReceiptId)(ids.receipt), true);
  for (const id of Object.values(ids)) {
    const uuid = toUUID(fromString(id));
    assert.strictEqual(uuid[14], "7");
    assert.strictEqual(["8", "9", "a", "b"].includes(uuid[19]!), true);
    assert.strictEqual(uuid.slice(0, 13), source.slice(0, 13));
  }
});

it("uses an explicit timestamp without reading the clock", () => {
  const id = deterministicMigrationId(
    "projection",
    new Date("2026-09-16T00:00:00.000Z"),
    "legacy-projection",
  );
  assert.strictEqual(Schema.is(ProjectionId)(id), true);
  assert.strictEqual(
    new Date(
      Number.parseInt(toUUID(fromString(id)).replaceAll("-", "").slice(0, 12), 16),
    ).toISOString(),
    "2026-09-16T00:00:00.000Z",
  );
});
