import * as Scene from "foldkit/scene";
import { expect, it } from "vitest";
import type { PersistedStore } from "../../src/atlas/data.ts";
import { framesOn, paletteEntries, update, view } from "../src/main.ts";
import { AtlasData } from "../src/model.ts";
import { routeOf, storeHref } from "../src/route.ts";
import { atlas, loadedAt, urlAt } from "./fixture.ts";
import { settle } from "./settle.ts";

const store: PersistedStore = {
  id: "author-journal",
  name: "Author history SQLite",
  scope: "Device",
  format: "SQLite",
  paths: ["<home>/history/journal.sqlite"],
  owner: "AuthorHistory",
  owners: [],
  description: "Ordered revision events.",
  definitions: [
    {
      name: "HistoryEvent",
      file: "packages/skit/src/author/internal/history.ts",
      line: 105,
      source: "CREATE TABLE author_history_events (event_json TEXT NOT NULL)",
    },
  ],
};
const data = {
  ...atlas,
  persistence: [
    store,
    { ...store, id: "state", name: "Library state", paths: ["<home>/state.json"], definitions: [] },
  ],
};
const loaded = (href: string) => ({ ...loadedAt(href), atlas: AtlasData.Success({ data }) });

it("lists paths and owners and searches by database fields", () => {
  Scene.scene(
    { update, view },
    Scene.given(loaded("#/data")),
    settle,
    Scene.expect(Scene.role("link", { name: "Library state" })).toExist(),
    Scene.expect(Scene.text("<home>/state.json")).toExist(),
    Scene.type(Scene.role("searchbox", { name: "Search persisted data" }), "event_json"),
    settle,
    Scene.expect(Scene.role("link", { name: store.name })).toExist(),
    Scene.expect(Scene.role("link", { name: "Library state" })).not.toExist(),
    Scene.expect(Scene.role("link", { name: store.name })).toHaveAttr("href", storeHref(store.id)),
  );
});

it("deep-links to storage definitions without loading terminal recordings", () => {
  const href = storeHref(store.id);
  const route = routeOf(urlAt(href));
  expect(route).toEqual({ _tag: "PersistedStore", id: store.id });
  expect(framesOn(data, route)).toEqual([]);
  Scene.scene(
    { update, view },
    Scene.given(loaded(href)),
    settle,
    Scene.expect(Scene.role("heading", { name: store.name })).toExist(),
    Scene.expect(Scene.text("<home>/history/journal.sqlite")).toExist(),
    Scene.expect(Scene.role("button", { name: "HistoryEvent" })).toHaveAttr(
      "aria-expanded",
      "false",
    ),
    Scene.click(Scene.role("button", { name: "HistoryEvent" })),
    settle,
    Scene.expect(Scene.role("region", { name: "HistoryEvent" })).toContainText(
      "event_json TEXT NOT NULL",
    ),
    Scene.expect(Scene.role("button", { name: "HistoryEvent" })).toHaveAttr(
      "aria-expanded",
      "true",
    ),
  );
  expect(
    paletteEntries(data).some(
      ({ href: target, item }) =>
        target === href && item.keywords?.some((keyword) => keyword.includes("event_json")),
    ),
  ).toBe(true);
});

it("shows the missing-store page for an unknown deep link", () => {
  Scene.scene(
    { update, view },
    Scene.given(loaded(storeHref("missing"))),
    settle,
    Scene.expect(Scene.role("heading", { name: "Not in the Atlas" })).toExist(),
  );
});

it("keeps owner source and definition expansion independent and resets on navigation", () => {
  const withOwner = {
    ...store,
    owners: [
      {
        name: "History",
        file: "history.ts",
        line: 1,
        source: "owner source",
        errors: ["writer.ts/WriterBusy"],
      },
    ],
  };
  const model = {
    ...loaded(storeHref(store.id)),
    atlas: AtlasData.Success({ data: { ...data, persistence: [withOwner] } }),
  };
  Scene.scene(
    { update, view },
    Scene.given(model),
    settle,
    Scene.expect(Scene.role("link", { name: "writer.ts/WriterBusy" })).toHaveAttr(
      "href",
      "#/errors/writer.ts/WriterBusy",
    ),
    Scene.click(Scene.role("button", { name: "history.ts:1 — History" })),
    settle,
    Scene.expect(Scene.role("region", { name: "history.ts:1 — History" })).toContainText(
      "owner source",
    ),
    Scene.click(Scene.role("button", { name: "HistoryEvent" })),
    settle,
    Scene.expect(Scene.role("button", { name: "history.ts:1 — History" })).toHaveAttr(
      "aria-expanded",
      "true",
    ),
    Scene.expect(Scene.role("button", { name: "HistoryEvent" })).toHaveAttr(
      "aria-expanded",
      "true",
    ),
  );
  expect(
    update(
      { ...model, detailDisclosures: { expanded: ["owner-0", "definition-0"] } },
      { _tag: "ChangedUrl", url: urlAt("#/data") },
    ).model.detailDisclosures.expanded,
  ).toEqual([]);
});
