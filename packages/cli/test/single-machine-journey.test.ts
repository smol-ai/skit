import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Schema } from "effect";
import {
  type AnyOutputContract,
  type ContractDataOf,
  outputContracts,
} from "../src/commands/output-contracts.js";

const bin = join(process.cwd(), "bin", "skit.js");

test("a Library Owner can manage a Skill through its complete single-machine lifecycle", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "skit-single-machine-"));
  const source = join(workspace, "skills");
  const home = join(workspace, "home");
  const codexRoot = join(workspace, "codex");
  await mkdir(join(source, "code-review"), { recursive: true });
  await writeFile(
    join(source, "code-review", "SKILL.md"),
    "---\nname: code-review\ndescription: Review code.\n---\n\n# Code Review\n",
  );

  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [bin, ...args, "--json", "--home", home, "--codex-root", codexRoot],
      { encoding: "utf8" },
    );
  /**
   * Run a command and decode its stdout with that command's own published output contract.
   *
   * Each command owns an authoritative schema in output-contracts.ts. Decoding against the real
   * one is what makes this a lifecycle test: a command that stops honouring its contract fails
   * here, and no field can be read that the contract does not promise.
   */
  function succeed<C extends AnyOutputContract>(contract: C, ...args: string[]): ContractDataOf<C>;
  function succeed(contract: AnyOutputContract, ...args: string[]): unknown {
    const result = run(...args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = Schema.decodeUnknownSync(
      Schema.Struct({ schema: Schema.Literal(contract.id), data: Schema.Unknown }),
    )(JSON.parse(result.stdout));
    return Schema.decodeUnknownSync(contract.schema)(envelope.data);
  }

  expect(succeed(outputContracts.list, "list")).toMatchObject({ collections: [], bindings: [] });

  const added = succeed(outputContracts.add, "add", source);
  const collectionId = added.collection_id;
  if (collectionId === undefined) throw new Error("expected source-tree Collection");
  const initialList = succeed(outputContracts.list, "list");
  expect(initialList).toMatchObject({
    collections: [expect.objectContaining({ collection_id: collectionId })],
    bindings: [],
  });
  const skill = initialList.collections[0]?.skills.find(
    (candidate) => candidate.name === "code-review",
  );
  expect(skill).toBeDefined();
  succeed(outputContracts.enable, "enable", skill!.name, "--for", "codex");
  expect(await readFile(join(codexRoot, "code-review", "SKILL.md"), "utf8")).toContain(
    "# Code Review",
  );
  expect(existsSync(join(codexRoot, "code-review", "agents", "openai.yaml"))).toBe(false);
  expect(succeed(outputContracts.list, "list").bindings).toEqual([
    expect.objectContaining({
      harness: "codex",
      skills: [skill!.skill_id],
    }),
  ]);

  const overridden = succeed(
    outputContracts.enable,
    "enable",
    skill!.name,
    "--for",
    "codex",
    "--invocation",
    "implicit",
  );
  expect(overridden.bindings).toEqual([
    expect.objectContaining({ invocation_policies: { [skill!.skill_id]: "implicit" } }),
  ]);
  expect(await readFile(join(codexRoot, "code-review", "agents", "openai.yaml"), "utf8")).toContain(
    "allow_implicit_invocation: true",
  );

  const reset = succeed(
    outputContracts.enable,
    "enable",
    skill!.name,
    "--for",
    "codex",
    "--invocation",
    "declared",
  );
  expect(reset.bindings).toEqual([
    expect.not.objectContaining({ invocation_policies: expect.anything() }),
  ]);
  expect(existsSync(join(codexRoot, "code-review", "agents", "openai.yaml"))).toBe(false);

  succeed(outputContracts.disable, "disable", skill!.name, "--for", "codex");
  expect(existsSync(join(codexRoot, "code-review"))).toBe(false);
  expect(succeed(outputContracts.list, "list").bindings).toEqual([]);

  succeed(outputContracts.remove, "remove", collectionId);
  expect(succeed(outputContracts.list, "list")).toMatchObject({ collections: [], bindings: [] });
}, 30_000);
