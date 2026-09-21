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
