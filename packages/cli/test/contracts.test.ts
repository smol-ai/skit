import { join, resolve } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { it } from "@effect/vitest";
import { makeCollectionId, makeSkillId, skitLayer } from "@smolai/skit-core";
import { describe, expect, test } from "vitest";
import { commandContractArtifacts } from "../src/commands/artifacts.js";
import { outputContracts } from "../src/commands/output-contracts.js";
import { commandApplicationLayer } from "../src/application.js";
import { result } from "../src/handlers/contracts.js";
import { renderContract } from "../src/presentation/contract-presenters.js";
import { defaultTerminalEnvironment, renderResultFrame } from "../src/presentation/output-frame.js";
import { writeCommandContractArtifacts } from "../src/commands/contract-writer.js";

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
      const artifacts = yield* commandContractArtifacts();
      for (const contents of Object.values(artifacts))
        expect(() => JSON.parse(contents)).not.toThrow();
      const manifest: {
        readonly commands: readonly { readonly outputSchemas: readonly string[] }[];
      } = JSON.parse(artifacts["command-manifest.json"] ?? "{}");
      const files = new Set(Object.keys(artifacts));
      for (const id of manifest.commands.flatMap((command) => command.outputSchemas))
        expect(files.has(`${id}.json`), `${id} must resolve to a generated contract`).toBe(true);
    }).pipe(Effect.provide(commandApplicationLayer(false, "/tmp/skit-contract-json-test"))),
  );

  it.effect("overwrites and prunes branch-local generated artifacts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const target = yield* fs.makeTempDirectoryScoped({ prefix: "skit-contract-version-" });
      const name = "skit.example.v1.json";
      yield* fs.writeFileString(join(target, name), "old shape\n");
      yield* fs.writeFileString(join(target, "stale.json"), "stale\n");
      yield* fs.writeFileString(join(target, "notes.txt"), "keep\n");
      yield* writeCommandContractArtifacts(target, {
        [name]: "new shape\n",
      });
      expect(yield* fs.readFileString(join(target, name))).toBe("new shape\n");
      expect(yield* fs.exists(join(target, "stale.json"))).toBe(false);
      expect(yield* fs.readFileString(join(target, "notes.txt"))).toBe("keep\n");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
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
        action: "enable",
        changed: true,
        enabled: [{ skill: skillId }],
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
    const value = result("version", { version: "1.2.3" });
    expect(value).toMatchObject({
      schema: "skit.version.v1",
      data: { version: "1.2.3" },
      encodedData: { version: "1.2.3" },
    });
  });

  test("pairs a contract key only with its own contract's data", () => {
    // Typecheck is the assertion: a key that may name either contract cannot carry one branch's data.
    const render = (key: "version" | "list") => {
      const data = { version: "1.2.3" };
      // @ts-expect-error a union key is not one contract
      result(key, data);
      renderContract(
        // @ts-expect-error the contract and data come from different branches
        { contract: key, schema: "skit.version.v1", data, encodedData: data },
        { color: false, detail: "summary" },
      );
      renderResultFrame(
        // @ts-expect-error the contract and data come from different branches
        { contract: key, schema: "skit.version.v1", data, encodedData: data },
        defaultTerminalEnvironment,
      );
    };
    render("version");
  });
});
