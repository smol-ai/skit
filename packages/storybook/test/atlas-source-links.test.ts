import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { commandCoverage } from "@smolai/skit/storybook";
import { beforeAll, expect, it } from "vitest";
import { PersistedStore } from "../src/atlas/data.ts";
import { commandErrors } from "../src/atlas/command-errors.ts";
import { atlasProgram, inspectErrors } from "../src/atlas/errors.ts";
import { persistedStores, storeOwnerFiles } from "../src/atlas/persistence.ts";
import { domainVocabulary } from "../src/atlas/vocabulary.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let program: Awaited<ReturnType<typeof atlasProgram>>;
let stores: Awaited<ReturnType<typeof persistedStores>>;

beforeAll(async () => {
  program = await atlasProgram(root);
  stores = await persistedStores(root, program);
}, 30_000);

it("joins the executable commands and persisted owners to real error symbols", async () => {
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

it("reads real storage definitions, including SQLite DDL and every Registry migration", () => {
  expect(Schema.is(Schema.Array(PersistedStore))(stores)).toBe(true);
  expect(new Set(stores.map((store) => store.id)).size).toBe(stores.length);
  const sourceOf = (id: string) =>
    stores
      .find((store) => store.id === id)!
      .definitions.map((definition) => definition.source)
      .join("\n");
  expect(sourceOf("author-journal")).toContain("CREATE TABLE author_history_workspaces");
  expect(sourceOf("author-journal")).toContain("CREATE TABLE author_history_events");
  expect(sourceOf("library-state")).toContain("library_local_draft_imports");
  expect(sourceOf("author-objects")).toContain("author_revision_parents");
  expect(sourceOf("author-sync")).toContain("author_sync_checkpoints");
  const migrations = stores.find((store) => store.id === "registry-database")!.definitions;
  expect(migrations[0]!.file).toMatch(/0001_initial.sql$/);
  expect(migrations.at(-1)!.file).toMatch(/0012_revision_edit_times.sql$/);
  expect(
    migrations.every((definition) => definition.source.length > 0 && definition.line >= 1),
  ).toBe(true);
});
