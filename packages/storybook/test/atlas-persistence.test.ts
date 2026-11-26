import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { PersistedStore } from "../src/atlas/data.ts";
import { persistedStores } from "../src/atlas/persistence.ts";

it("reads real storage definitions, including SQLite DDL and every Registry migration", async () => {
  const stores = await persistedStores(fileURLToPath(new URL("../../../", import.meta.url)));
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
