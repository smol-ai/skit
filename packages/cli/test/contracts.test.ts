import { join, resolve } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { it } from "@effect/vitest";
import { makeCollectionId, makeSkillId, skitLayer } from "@smolai/skit-core";
import { describe, expect, test } from "vitest";
import { commandContractArtifacts } from "../src/commands/artifacts.js";
import { outputContracts } from "../src/commands/output-contracts.js";
import { commandApplicationLayer } from "../src/application.js";
import { result } from "../src/handlers/contracts.js";

const contractsRoot = resolve(import.meta.dirname, "../contracts");

describe("generated command contracts", () => {
  it.effect("committed artifacts exactly match deterministic generation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const expected = yield* commandContractArtifacts();
      expect((yield* fs.readDirectory(contractsRoot)).sort()).toEqual(Object.keys(expected));
      for (const [name, contents] of Object.entries(expected))
        expect(yield* fs.readFileString(join(contractsRoot, name))).toBe(contents);
    }).pipe(
      Effect.provide(commandApplicationLayer(false, "/tmp/skit-contract-generation-test")),
      Effect.provide(skitLayer),
    ),
  );

  it.effect("owns every output schema exactly once and emits valid JSON", () =>
    Effect.gen(function* () {
      const contracts = Object.values(outputContracts);
      expect(new Set(contracts.map((contract) => contract.id))).toHaveLength(contracts.length);
      for (const contents of Object.values(yield* commandContractArtifacts()))
        expect(() => JSON.parse(contents)).not.toThrow();
    }).pipe(Effect.provide(commandApplicationLayer(false, "/tmp/skit-contract-json-test"))),
  );

  test("schemas validate representative branching payloads", () => {
    const collectionId = makeCollectionId();
    const skillId = makeSkillId();
    expect(() => Schema.decodeUnknownSync(outputContracts.updatePlan.schema)([])).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(outputContracts.enablePlan.schema)({
        subject_id: collectionId,
        skills: ["review"],
        harnesses: ["codex"],
        scope: { kind: "global" },
        enabled: true,
        changed: true,
        bindings: [
          {
            harness: "codex",
            scope: { kind: "global" },
            skills: [skillId],
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(outputContracts.registryRemote.schema)({
        name: "public",
        origin: "https://registry.example",
        isDefault: true,
        action: "defaulted",
      }),
    ).not.toThrow();
  });

  test("encodes producer data at the command-result boundary", () => {
    const value = result("version", outputContracts.version, { version: "1.2.3" });
    expect(value).toMatchObject({
      schema: "skit.version.v1",
      data: { version: "1.2.3" },
      encodedData: { version: "1.2.3" },
    });
  });
});
