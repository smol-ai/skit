import { describe, expect, test } from "vitest";
import { checkContractCompatibility } from "../src/commands/contract-compatibility.js";

const artifact = (id: string, shape: string) =>
  `${JSON.stringify({ $id: id, type: "object", properties: { [shape]: { type: "string" } } })}\n`;

const manifest = (stability: "stable" | "experimental", outputSchemas: readonly string[]) =>
  JSON.stringify({ commands: [{ stability, outputSchemas }] });

describe("contract compatibility", () => {
  test("freezes stable IDs from the base", () => {
    const result = checkContractCompatibility({
      baseArtifacts: { "skit.list.v2.json": artifact("skit.list.v2", "before") },
      headArtifacts: { "skit.list.v2.json": artifact("skit.list.v2", "after") },
      baseManifest: manifest("stable", ["skit.list.v2"]),
    });
    expect(result.errors).toEqual(["skit.list.v2 changed shape without changing its contract ID"]);
  });

  describe("compares what a schema accepts, not how it is written", () => {
    const schema = (id: string, count: object, fitted: object) =>
      `${JSON.stringify({ $id: id, type: "object", properties: { count, fitted } })}\n`;
    const nested = {
      anyOf: [{ anyOf: [{ type: "number" }, { type: "string", enum: ["NaN"] }] }, { type: "null" }],
    };
    const flat = {
      anyOf: [{ type: "number" }, { type: "string", enum: ["NaN"] }, { type: "null" }],
    };
    const check = (before: string, after: string) =>
      checkContractCompatibility({
        baseArtifacts: { "skit.list.v2.json": before },
        headArtifacts: { "skit.list.v2.json": after },
        baseManifest: manifest("stable", ["skit.list.v2"]),
      });

    test("accepts bounds folded out of allOf and unions flattened", () => {
      const before = schema(
        "skit.list.v2",
        {
          type: "integer",
          minimum: -9007199254740991,
          maximum: 9007199254740991,
          allOf: [{ minimum: 0 }],
        },
        nested,
      );
      const after = schema(
        "skit.list.v2",
        { type: "integer", minimum: 0, maximum: 9007199254740991 },
        flat,
      );
      expect(check(before, after)).toEqual({ errors: [], warnings: [] });
    });

    test("still rejects a bound that accepts different values", () => {
      const before = schema("skit.list.v2", { type: "integer", allOf: [{ minimum: 0 }] }, flat);
      const after = schema("skit.list.v2", { type: "integer", minimum: 1 }, flat);
      expect(check(before, after).errors).toEqual([
        "skit.list.v2 changed shape without changing its contract ID",
      ]);
    });

    test("still rejects a union that gains a member", () => {
      const before = schema("skit.list.v2", { type: "integer" }, nested);
      const after = schema(
        "skit.list.v2",
        { type: "integer" },
        {
          anyOf: [...flat.anyOf, { type: "boolean" }],
        },
      );
      expect(check(before, after).errors).toEqual([
        "skit.list.v2 changed shape without changing its contract ID",
      ]);
    });
  });

  test("allows one stable version increment", () => {
    const result = checkContractCompatibility({
      baseArtifacts: { "skit.list.v2.json": artifact("skit.list.v2", "before") },
      headArtifacts: { "skit.list.v3.json": artifact("skit.list.v3", "after") },
      baseManifest: manifest("stable", ["skit.list.v2"]),
    });
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  test("rejects skipped stable versions", () => {
    const result = checkContractCompatibility({
      baseArtifacts: { "skit.setup.v3.json": artifact("skit.setup.v3", "before") },
      headArtifacts: { "skit.setup.v5.json": artifact("skit.setup.v5", "after") },
      baseManifest: manifest("stable", ["skit.setup.v3"]),
    });
    expect(result.errors).toEqual([
      "skit.setup.v3 was removed without a one-version successor",
      "skit.setup jumped from v3 to v5; use v4",
    ]);
  });

  test("allows a named stable contract to be retired without a successor", () => {
    const result = checkContractCompatibility({
      baseArtifacts: {
        "skit.pin.v5.json": artifact("skit.pin.v5", "before"),
        "skit.pull.v6.json": artifact("skit.pull.v6", "before"),
        "skit.example.v1.json": artifact("skit.example.v1", "before"),
      },
      headArtifacts: {},
      baseManifest: manifest("stable", ["skit.pin.v5", "skit.pull.v6", "skit.example.v1"]),
    });
    expect(result).toEqual({
      errors: ["skit.example.v1 was removed without a one-version successor"],
      warnings: ["skit.pin.v5 was retired", "skit.pull.v6 was retired"],
    });
  });

  test("warns when an experimental contract changes in place", () => {
    const result = checkContractCompatibility({
      baseArtifacts: { "skit.audit.v1.json": artifact("skit.audit.v1", "before") },
      headArtifacts: { "skit.audit.v1.json": artifact("skit.audit.v1", "after") },
      baseManifest: manifest("experimental", ["skit.audit.v1"]),
    });
    expect(result).toEqual({
      errors: [],
      warnings: ["skit.audit.v1 changed shape without changing its contract ID"],
    });
  });
});
