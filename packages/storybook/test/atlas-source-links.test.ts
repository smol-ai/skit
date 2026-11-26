import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { commandCoverage } from "@smolai/skit/storybook";
import { expect, it } from "vitest";
import { commandErrors } from "../src/atlas/command-errors.ts";
import { atlasProgram, inspectErrors } from "../src/atlas/errors.ts";
import { persistedStores, storeOwnerFiles } from "../src/atlas/persistence.ts";
import { domainVocabulary } from "../src/atlas/vocabulary.ts";

it("joins the executable commands and persisted owners to real error symbols", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const program = await atlasProgram(root);
  const commands = commandErrors(program, root);
  const documented = await Effect.runPromise(commandCoverage);
  expect([...commands.keys()].sort()).toEqual(documented.map((command) => command.command).sort());
  expect(commands.has("author pull")).toBe(true);
  const errors = inspectErrors(program, root, storeOwnerFiles);
  const keys = new Set(errors.map((error) => `${error.file}/${error.name}`));
  for (const [name, failures] of commands) {
    for (const key of failures)
      expect(keys.has(key) || key.includes("node_modules/"), `${name}: ${key}`).toBe(true);
  }
  for (const name of [
    "enable",
    "disable",
    "repository watch",
    "repository ignore",
    "repository forget",
  ])
    expect(
      commands.get(name)?.some((key) => key.endsWith("/HomeBusy")),
      name,
    ).toBe(true);
  expect(commands.get("version")?.every((key) => key.includes("node_modules/"))).toBe(true);
  // Undo converts failures into setupUndo results rather than failing its checked channel.
  expect(commands.get("library undo")).toEqual([]);
  const stores = await persistedStores(root, program);
  for (const store of stores) {
    expect(store.owners.length, store.id).toBeGreaterThan(0);
    for (const owner of store.owners) {
      expect(owner.source).toContain(owner.name);
      expect(owner.line).toBeGreaterThan(0);
      for (const key of owner.errors) expect(keys.has(key), key).toBe(true);
    }
  }
  expect(
    stores
      .find((store) => store.id === "author-journal")
      ?.owners[0]?.errors.some((key) => key.endsWith("/AuthorHistoryInvalid")),
  ).toBe(true);
  const vocabulary = await domainVocabulary(root);
  expect(vocabulary.vocabulary.find((entry) => entry.term === "Ownership")?.meaning).toContain(
    "authority",
  );
  expect(vocabulary.verbs.find((entry) => entry.verb === "scan")?.meaning).toContain(
    "Changes nothing",
  );
}, 30000);
