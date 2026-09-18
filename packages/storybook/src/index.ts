#!/usr/bin/env bun

import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { defaultTerminalEnvironment, renderJourney, journeyStories } from "../../cli/src/front-end";
import { catalog, filterCatalog, renderOutput, type CatalogItem } from "./model";

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  screenMode: "alternate-screen",
  useMouse: true,
});
const colors = {
  canvas: "#09090b",
  panel: "#18181b",
  border: "#3f3f46",
  accent: "#38bdf8",
  text: "#e4e4e7",
  muted: "#71717a",
  selected: "#0ea5e9",
};

let items: ReadonlyArray<CatalogItem> = catalog;
let selected = 0;
let format: "human" | "json" = "human";
let detail: "summary" | "full" = "summary";
let query = "";
let current: BoxRenderable | undefined;
let generation = 0;
let list: SelectRenderable;
let previewBox: BoxRenderable;
let previewText: TextRenderable;
let previewScroll: ScrollBoxRenderable;

const environment = () => ({
  ...defaultTerminalEnvironment,
  format,
  detail,
});

const text = (id: string, content: string, options = {}) =>
  new TextRenderable(renderer, { id, content, fg: colors.text, ...options });

function selectedItem(): CatalogItem | undefined {
  return items[selected];
}

function outputPreview(item: CatalogItem): string {
  if (item.kind === "output") return renderOutput(item.index, environment());
  const story = journeyStories[item.index];
  if (!story) return "Journey not found";
  return [
    `INITIAL\n${story.initialState}`,
    `\nSCRIPTED ANSWERS\n${story.answers.map((answer, index) => `${index + 1}. ${Array.isArray(answer) ? answer.join(", ") : answer === true ? "yes" : answer === false ? "no" : answer}`).join("\n")}`,
    "\nRunning journey…",
  ].join("\n");
}

function draw(preview?: string): void {
  if (current) {
    renderer.root.remove(current);
    current.destroyRecursively();
  }
  const root = new BoxRenderable(renderer, {
    id: "storybook",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: colors.canvas,
  });
  root.add(
    text(
      "header",
      ` SKIT OUTPUTS · SLOP DEVTOOL   ${items.length} stories   ${format.toUpperCase()} / ${detail.toUpperCase()}`,
      { height: 2, fg: colors.accent },
    ),
  );
  const search = new InputRenderable(renderer, {
    id: "search",
    width: "100%",
    placeholder: "Search outputs and journeys…",
    value: query,
    textColor: colors.text,
    cursorColor: colors.accent,
    backgroundColor: colors.panel,
  });
  search.on(InputRenderableEvents.INPUT, (value: string) => {
    query = value;
    items = filterCatalog(value);
    selected = 0;
    draw();
  });
  root.add(search);
  const body = new BoxRenderable(renderer, {
    id: "body",
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
    padding: 1,
  });
  const sidebar = new BoxRenderable(renderer, {
    id: "catalog",
    width: 43,
    height: "100%",
    border: true,
    borderColor: colors.border,
    title: " CATALOG ",
  });
  list = new SelectRenderable(renderer, {
    id: "stories",
    width: "100%",
    height: "100%",
    selectedIndex: selected,
    options: items.map((item) => ({
      name: item.key,
      description: item.kind === "output" ? "COMMAND OUTPUT" : "INTERACTIVE JOURNEY",
      value: item.key,
    })),
    textColor: colors.text,
    descriptionColor: colors.muted,
    selectedBackgroundColor: colors.selected,
    selectedTextColor: colors.canvas,
    selectedDescriptionColor: colors.canvas,
    showScrollIndicator: true,
    wrapSelection: true,
  });
  list.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
    selected = index;
    void refreshPreview();
  });
  sidebar.onMouseScroll = (event) => {
    const steps = Math.max(1, Math.round(Math.abs(event.scroll?.delta ?? 1)));
    if (event.scroll?.direction === "up") list.moveUp(steps);
    if (event.scroll?.direction === "down") list.moveDown(steps);
    event.preventDefault();
    event.stopPropagation();
  };
  sidebar.add(list);
  previewBox = new BoxRenderable(renderer, {
    id: "preview",
    flexGrow: 1,
    minWidth: 0,
    height: "100%",
    border: true,
    borderColor: colors.accent,
    title: ` PREVIEW · ${selectedItem()?.key ?? "NO MATCH"} `,
    padding: 1,
  });
  previewScroll = new ScrollBoxRenderable(renderer, {
    id: "preview-scroll",
    width: "100%",
    height: "100%",
    verticalScrollbarOptions: { visible: true },
  });
  previewText = text("preview-text", preview ?? outputPreview(selectedItem() ?? catalog[0]));
  previewScroll.add(previewText);
  previewBox.add(previewScroll);
  body.add(sidebar);
  body.add(previewBox);
  root.add(body);
  root.add(
    text(
      "footer",
      " ↑↓/wheel browse   type search   ctrl+f format   ctrl+d detail   esc clear   ctrl+c quit",
      {
        height: 2,
        fg: colors.muted,
      },
    ),
  );
  current = root;
  renderer.root.add(root);
  search.focus();
}

function replacePreviewText(content: string): void {
  previewScroll.remove(previewText);
  previewText.destroyRecursively();
  previewText = text("preview-text", content);
  previewScroll.add(previewText);
}

async function updatePreview(content: string, token: number): Promise<void> {
  previewBox.title = ` PREVIEW · ${selectedItem()?.key ?? "NO MATCH"} `;
  replacePreviewText("");
  previewScroll.scrollTo(0);
  renderer.requestRender();
  await renderer.idle();
  if (token !== generation) return;
  replacePreviewText(content);
  renderer.requestRender();
}

async function refreshPreview(): Promise<void> {
  const item = selectedItem();
  const token = ++generation;
  if (!item) return updatePreview("No matching stories", token);
  if (item.kind === "output") return updatePreview(renderOutput(item.index, environment()), token);
  await updatePreview(outputPreview(item), token);
  if (token !== generation) return;
  const story = journeyStories[item.index];
  if (!story) return;
  const rendered = await Effect.runPromise(
    renderJourney(story, environment(), process.cwd()).pipe(Effect.provide(NodeServices.layer)),
  );
  if (token === generation) await updatePreview(rendered, token);
}

function handleKey(key: KeyEvent): void {
  if (key.ctrl && key.name === "c") return renderer.destroy();
  if (key.name === "up") list.moveUp();
  else if (key.name === "down") list.moveDown();
  else if (key.ctrl && key.name === "f") {
    format = format === "human" ? "json" : "human";
    void refreshPreview();
  } else if (key.ctrl && key.name === "d") {
    detail = detail === "summary" ? "full" : "summary";
    void refreshPreview();
  } else if (key.name === "escape") {
    query = "";
    items = catalog;
    selected = 0;
    draw();
  }
}

renderer.keyInput.on("keypress", handleKey);
draw();
