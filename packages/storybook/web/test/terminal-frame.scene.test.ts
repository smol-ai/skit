import * as Scene from "foldkit/scene";
import { describe, it } from "vitest";
import type { Frame } from "../../src/atlas/data.ts";
import { terminalFrame } from "../src/components/terminal-frame.ts";
import { update, view } from "../src/main.ts";
import { commandHref, flowHref, issuesHref, storyHref } from "../src/route.ts";
import { loadedAt, runningFrame } from "./fixture.ts";
import { settle } from "./settle.ts";

const frameScene = (frame: Frame, ...steps: Parameters<typeof Scene.scene<Frame, never>>[1][]) =>
  Scene.scene<Frame, never>(
    {
      update: (model) => ({ model }),
      view: (model, h) => terminalFrame(h, model, { label: "Downloading copies" }),
    },
    Scene.given(frame),
    ...steps,
  );

describe("a terminal frame", () => {
  it("draws each run as text in its theme colour and style", () => {
    frameScene(
      runningFrame,
      Scene.expect(Scene.role("group", { name: "Downloading copies" })).toExist(),
      Scene.expect(Scene.text("✓")).toHaveStyle("color", "var(--terminal-2)"),
      Scene.expect(Scene.selector("pre .bold")).toContainText("Retired"),
      Scene.expect(Scene.selector("pre .dim")).toHaveText("$ skit sync --apply"),
    );
  });

  it("keeps optional controls and output in one terminal group", () => {
    Scene.scene<Frame, never>(
      {
        update: (model) => ({ model }),
        view: (model, h) =>
          terminalFrame(h, model, {
            label: "Replay",
            header: h.nav([h.AriaLabel("Replay controls")], ["Previous / 1 of 2 / Next"]),
          }),
      },
      Scene.given(runningFrame),
      Scene.expect(Scene.role("group", { name: "Replay" })).toContainText(
        "Previous / 1 of 2 / Next",
      ),
      Scene.expect(Scene.role("group", { name: "Replay" })).toContainText("Retired"),
      Scene.expect(Scene.role("navigation", { name: "Replay controls" })).toExist(),
      Scene.expect(Scene.selector("pre")).toHaveStyle("borderTopLeftRadius", "0"),
      Scene.expect(Scene.selector(".terminal-frame .terminal-frame")).not.toExist(),
    );
  });

  it("marks a copy issue around the characters it covers", () => {
    frameScene(runningFrame, Scene.expect(Scene.selector("mark.issue")).toHaveText("Retired"));
  });

  it("draws the status line's spinner glyphs out of the accessibility tree", () => {
    frameScene(
      runningFrame,
      Scene.expect(Scene.selector(".spinner")).toHaveAttr("aria-hidden", "true"),
      Scene.expect(Scene.selector(".spinner")).toHaveStyle("--frames", "2"),
      Scene.expect(Scene.selector(".spinner")).toContainText("⠋⠙"),
    );
  });
});

describe("a flow step", () => {
  it("keeps replay controls available while its frame is loading", () => {
    Scene.scene(
      { update, view },
      Scene.given({ ...loadedAt(flowHref("library-sync/fresh-device", 1)), frames: {} }),
      settle,
      Scene.expect(Scene.role("navigation", { name: "Steps" })).toExist(),
      Scene.expect(Scene.text(/Loading library-sync/)).toExist(),
      Scene.expect(Scene.selector("pre")).not.toExist(),
    );
  });

  it("links each copy issue to the issues, saying why it is flagged", () => {
    Scene.scene(
      { update, view },
      Scene.given(loadedAt(flowHref("library-sync/fresh-device", 3))),
      settle,
      Scene.expect(Scene.role("link", { name: "Retired" })).toHaveAttr("href", "#/issues"),
      Scene.focus(Scene.role("link", { name: "Retired" })),
      settle,
      Scene.expect(Scene.role("tooltip")).toHaveText("Avoided verb: retire, CONTEXT.md"),
    );
  });
});

describe("copy issues in stories", () => {
  it("are marked in a story's selected frame, linking to the issues", () => {
    Scene.scene(
      { update, view },
      Scene.given(loadedAt(storyHref("library-sync/pushed"))),
      settle,
      Scene.expectAll(Scene.all.role("link", { name: "Retired" })).toHaveCount(1),
      Scene.expect(Scene.first(Scene.all.role("link", { name: "Retired" }))).toHaveAttr(
        "href",
        "#/issues",
      ),
    );
  });

  it("are counted on the story's card on its command's page", () => {
    Scene.scene(
      { update, view },
      Scene.given(loadedAt(commandHref("sync"))),
      settle,
      Scene.expect(Scene.role("link", { name: /library-sync\/pushed/ })).toHaveAttr(
        "aria-label",
        "library-sync/pushed, 2 copy issues",
      ),
      Scene.expect(Scene.text("2 copy issues")).toExist(),
    );
  });

  it("are listed once on the Issues page, with every place that shows them", () => {
    Scene.scene(
      { update, view },
      Scene.given(loadedAt(issuesHref)),
      settle,
      Scene.expectAll(Scene.all.selector("tbody tr")).toHaveCount(2),
      Scene.expect(
        Scene.role("link", { name: "library-sync/fresh-device, step 3: Pushed" }),
      ).toHaveAttr("href", flowHref("library-sync/fresh-device", 3)),
      Scene.expectAll(Scene.all.role("link", { name: "Story library-sync/pushed" })).toHaveCount(2),
    );
  });
});
