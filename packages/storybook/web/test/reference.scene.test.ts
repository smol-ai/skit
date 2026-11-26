import * as Scene from "foldkit/scene";
import { expect, it } from "vitest";
import { framesOn, update, view } from "../src/main.ts";
import { AtlasData, FrameData } from "../src/model.ts";
import { AppRoute, routeOf, terminalOutputVocabularyHref } from "../src/route.ts";
import { atlas, loadedAt, urlAt } from "./fixture.ts";
import { settle } from "./settle.ts";

it("shows the same Block at narrow and wide widths in the selected colour mode", () => {
  const blocks = [40, 100].map((width) => ({
    name: "Table",
    width,
    color: `blocks/${width}.json`,
    plain: `blocks/${width}.plain.json`,
  }));
  Scene.scene(
    { update, view },
    Scene.given({
      ...loadedAt(terminalOutputVocabularyHref),
      atlas: AtlasData.Success({ data: { ...atlas, blocks } }),
      frames: Object.fromEntries(
        blocks.flatMap((block) =>
          [block.color, block.plain].map((path) => [
            path,
            FrameData.Success({
              data: { rows: [{ runs: [{ text: `Table at ${block.width} columns` }] }] },
            }),
          ]),
        ),
      ),
    }),
    settle,
    Scene.expect(Scene.role("heading", { name: "Table (40 columns)" })).toExist(),
    Scene.expect(Scene.role("heading", { name: "Table (100 columns)" })).toExist(),
    Scene.expect(Scene.role("group", { name: "Table at 40 columns" })).toContainText(
      "Table at 40 columns",
    ),
    Scene.expect(Scene.role("group", { name: "Table at 100 columns" })).toContainText(
      "Table at 100 columns",
    ),
    Scene.click(Scene.role("switch", { name: "Colour" })),
    settle,
    Scene.expect(Scene.role("group", { name: "Table at 40 columns" })).toContainText(
      "Table at 40 columns",
    ),
    Scene.expect(Scene.role("group", { name: "Table at 100 columns" })).toContainText(
      "Table at 100 columns",
    ),
  );
});

it("keeps domain vocabulary separate from the terminal catalog", () => {
  const data = {
    ...atlas,
    vocabulary: [
      {
        group: "Authoring",
        term: "Revision",
        meaning: "Saved authored content.",
        avoid: "release",
      },
    ],
    verbs: [{ verb: "save", meaning: "Record authored content." }],
    frames: [{ name: "Note", width: 88, color: "note.json", plain: "note.plain.json" }],
    blocks: [{ name: "Table", width: 40, color: "table.json", plain: "table.plain.json" }],
  };
  expect(framesOn(data, AppRoute.Vocabulary())).toEqual([]);
  expect(framesOn(data, AppRoute.TerminalOutputVocabulary())).toEqual(["note.json", "table.json"]);
  expect(routeOf(urlAt(terminalOutputVocabularyHref))).toEqual(AppRoute.TerminalOutputVocabulary());
  expect(routeOf(urlAt(`${terminalOutputVocabularyHref}/unknown`))).toEqual(
    AppRoute.NotFound({ path: "/terminal-output-vocabulary/unknown" }),
  );
  Scene.scene(
    { update, view },
    Scene.given({ ...loadedAt("#/vocabulary"), atlas: AtlasData.Success({ data }) }),
    settle,
    Scene.expect(Scene.role("heading", { level: 1, name: "Vocabulary" })).toExist(),
    Scene.expect(Scene.text("Saved authored content.")).toExist(),
    Scene.expect(Scene.text("Record authored content.")).toExist(),
    Scene.expect(Scene.role("heading", { name: "Terminal frames" })).not.toExist(),
    Scene.expect(Scene.role("heading", { name: "Blocks" })).not.toExist(),
    Scene.expect(Scene.role("link", { name: "Terminal output vocabulary" })).toHaveAttr(
      "href",
      terminalOutputVocabularyHref,
    ),
  );
});
