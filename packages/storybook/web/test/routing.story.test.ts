import { serviceHref, servicesHref, commandTabHref } from "../src/route.ts";
import { Navigation } from "foldkit";
import * as Story from "foldkit/story";
import { describe, expect, it } from "vitest";
import * as CommandMenu from "../src/fluid/components/command-menu";
import * as CommandDialog from "../src/fluid/components/command-menu/dialog";
import { commandTabFor } from "../src/pages/command.ts";
import { framesOn, LoadFrame, NavigateTo, ScrollToTop, update } from "../src/main.ts";
import { FrameData, Message } from "../src/model.ts";
import {
  AppRoute,
  commandHref,
  flowHref,
  testHref,
  placeHref,
  routeOf,
  storyHref,
} from "../src/route.ts";
import { copyIssues, totals } from "../src/atlas.ts";
import { atlas, loadedAt, runningFrame, urlAt } from "./fixture.ts";

describe("service diagram emphasis", () => {
  it("does not let a late leave from another node erase the current focus", () => {
    Story.story(
      update,
      Story.given(loadedAt("#/services")),
      Story.message(Message.ChangedServiceNode({ id: "workspace", clear: false, input: "focus" })),
      Story.message(Message.ChangedServiceNode({ id: "registry", clear: false, input: "pointer" })),
      Story.message(Message.ChangedServiceNode({ id: "registry", clear: true, input: "pointer" })),
      Story.model((model) => expect(model.activeServiceNode.id).toBe("workspace")),
      Story.message(Message.ChangedServiceNode({ id: "workspace", clear: true, input: "focus" })),
      Story.model((model) => expect(model.activeServiceNode.id).toBe("")),
      Story.message(Message.ChangedServiceNode({ id: "registry", clear: false, input: "pointer" })),
      Story.model((model) => expect(model.activeServiceNode.id).toBe("registry")),
    );
  });
});

describe("routes", () => {
  it("round-trips every page through its hash link", () => {
    expect(routeOf(urlAt(commandHref("author sync")))).toEqual(
      AppRoute.Command({ path: "author/sync" }),
    );
    expect(routeOf(urlAt(flowHref("library-sync/fresh-device", 12)))).toEqual(
      AppRoute.Flow({ flow: "library-sync/fresh-device", step: 12 }),
    );
    expect(routeOf(urlAt(storyHref("library-sync/pushed")))).toEqual(
      AppRoute.Story({ key: "library-sync/pushed" }),
    );
    expect(routeOf(urlAt(""))).toEqual(AppRoute.Overview());
  });

  it("round-trips existing tab identifiers without confusing grouped command words", () => {
    for (const tab of [
      "invocation",
      "results",
      "states",
      "flows",
      "errors",
      "guarantees",
      "requirements",
    ] as const) {
      expect(routeOf(urlAt(commandTabHref("author watch", tab)))).toEqual(
        AppRoute.Command({ path: "author/watch", tab }),
      );
    }
    expect(routeOf(urlAt(testHref("author watch", "test/tabs/flows")))).toEqual(
      AppRoute.Command({ path: "author/watch", test: "test/tabs/flows" }),
    );
    expect(commandTabHref("author watch", "flows")).toBe("#/commands/author/watch/tabs/flows");
    expect(commandTabFor(atlas, AppRoute.Command({ path: "add" }))).toBe("results");
    expect(commandTabFor(atlas, AppRoute.Command({ path: "add", tab: "unknown" }))).toBeUndefined();
    expect(
      commandTabFor(atlas, AppRoute.Command({ path: "add", tab: "guarantees" })),
    ).toBeUndefined();
  });

  it("round-trips service identifiers and the Services index", () => {
    const id = "packages/skit/src/author/workspace.ts#AuthorWorkspace";
    expect(routeOf(urlAt(servicesHref))).toEqual(AppRoute.Services());
    expect(routeOf(urlAt(serviceHref(id)))).toEqual(AppRoute.Service({ id }));
    expect(routeOf(urlAt(commandTabHref("author publish", "requirements")))).toEqual(
      AppRoute.Command({ path: "author/publish", tab: "requirements" }),
    );
  });

  it("opens a flow named without a step at its first step", () => {
    expect(routeOf(urlAt("#/flows/doctor/cleanup-preview"))).toEqual(
      AppRoute.Flow({ flow: "doctor/cleanup-preview", step: 1 }),
    );
  });

  it("names an unknown page", () => {
    expect(routeOf(urlAt("#/nowhere"))).toEqual(AppRoute.NotFound({ path: "/nowhere" }));
  });
});

describe("navigation", () => {
  it("follows an Atlas link through the browser history", () => {
    const url = urlAt(commandHref("add"));
    Story.story(
      update,
      Story.given(loadedAt("#/")),
      Story.message(Message.ClickedLink({ request: Navigation.UrlRequest.Internal({ url }) })),
      Story.Command.expectExact(NavigateTo({ url: "http://127.0.0.1:5173/#/commands/add" })),
      Story.Command.resolve(NavigateTo, Message.CompletedNavigation()),
    );
  });

  it("opens a new page at its top", () => {
    Story.story(
      update,
      Story.given(loadedAt("#/")),
      Story.message(Message.ChangedUrl({ url: urlAt(commandHref("add")) })),
      Story.model((model) => expect(model.route).toEqual(AppRoute.Command({ path: "add" }))),
      Story.Command.expectExact(ScrollToTop),
      Story.Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
    );
  });

  it("keeps the scroll position while stepping through one flow", () => {
    Story.story(
      update,
      Story.given(loadedAt(flowHref("library-sync/fresh-device", 2))),
      Story.message(Message.ChangedUrl({ url: urlAt(flowHref("library-sync/fresh-device", 3)) })),
      Story.model((model) =>
        expect(model.route).toEqual(AppRoute.Flow({ flow: "library-sync/fresh-device", step: 3 })),
      ),
      Story.Command.expectNone(),
    );
  });

  it("shows a newly opened command's results first", () => {
    Story.story(
      update,
      Story.given({ ...loadedAt(commandTabHref("add", "flows")) }),
      Story.message(Message.ChangedUrl({ url: urlAt(commandHref("sync")) })),
      Story.model((model) => expect(model.route).toEqual(AppRoute.Command({ path: "sync" }))),
      Story.Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
    );
  });
});

describe("arrow keys in a flow", () => {
  it("move to the next and previous step", () => {
    Story.story(
      update,
      Story.given(loadedAt(flowHref("library-sync/fresh-device", 2))),
      Story.message(Message.PressedArrowKey({ direction: "next" })),
      Story.Command.expectExact(NavigateTo({ url: flowHref("library-sync/fresh-device", 3) })),
      Story.Command.resolve(NavigateTo, Message.CompletedNavigation()),
      Story.message(Message.PressedArrowKey({ direction: "previous" })),
      Story.Command.expectExact(NavigateTo({ url: flowHref("library-sync/fresh-device", 1) })),
      Story.Command.resolve(NavigateTo, Message.CompletedNavigation()),
    );
  });

  it("go through the steps a fork shares with its parent", () => {
    Story.story(
      update,
      Story.given(loadedAt(flowHref("library-sync/download-failed", 3))),
      Story.message(Message.PressedArrowKey({ direction: "previous" })),
      Story.Command.expectExact(NavigateTo({ url: flowHref("library-sync/download-failed", 2) })),
      Story.Command.resolve(NavigateTo, Message.CompletedNavigation()),
    );
  });

  it("stop at either end of the flow", () => {
    Story.story(
      update,
      Story.given(loadedAt(flowHref("library-sync/download-failed", 3))),
      Story.message(Message.PressedArrowKey({ direction: "next" })),
      Story.Command.expectNone(),
    );
    Story.story(
      update,
      Story.given(loadedAt(flowHref("library-sync/fresh-device", 1))),
      Story.message(Message.PressedArrowKey({ direction: "previous" })),
      Story.Command.expectNone(),
    );
  });

  it("do nothing outside a flow", () => {
    Story.story(
      update,
      Story.given(loadedAt(commandHref("add"))),
      Story.message(Message.PressedArrowKey({ direction: "next" })),
      Story.Command.expectNone(),
    );
  });
});

describe("the ⌘K menu", () => {
  it("opens the page of the row it picks", () => {
    const menu = (message: CommandMenu.Message) =>
      Message.Palette({ message: CommandDialog.Message.Menu({ message }) });
    Story.story(
      update,
      Story.given(loadedAt("#/")),
      Story.message(menu(CommandMenu.Message.QueryChanged({ query: "download-failed" }))),
      Story.message(menu(CommandMenu.Message.Picked({ index: null }))),
      Story.Command.expectHas(NavigateTo({ url: flowHref("library-sync/download-failed", 1) })),
      Story.Command.resolve(NavigateTo, Message.CompletedNavigation()),
    );
  });
});

describe("frames", () => {
  it("loads state examples even when they are absent from the command's result list", () => {
    const withStateExamples = {
      ...atlas,
      commands: atlas.commands.map((command) =>
        command.command === "sync" ? { ...command, stories: [] } : command,
      ),
    };
    expect(framesOn(withStateExamples, AppRoute.Command({ path: "sync" }))).toEqual([
      "frames/stories/library-sync/pushed.json",
    ]);
  });
  const story = {
    color: "frames/stories/add/added.json",
    plain: "frames/stories/add/added.plain.json",
  };

  it("load when a page first shows them", () => {
    Story.story(
      update,
      Story.given({ ...loadedAt("#/"), frames: {} }),
      Story.message(Message.ChangedUrl({ url: urlAt(storyHref("add/added")) })),
      Story.model((model) => expect(Object.keys(model.frames)).toEqual([story.color])),
      Story.Command.expectExact(ScrollToTop, LoadFrame({ path: story.color })),
      Story.Command.resolveAll(
        [ScrollToTop, Message.CompletedScrollToTop()],
        [
          LoadFrame({ path: story.color }),
          Message.LoadedFrame({ path: story.color, frame: runningFrame }),
        ],
      ),
      Story.model((model) => {
        expect(model.frames[story.color]).toEqual(FrameData.Success({ data: runningFrame }));
        expect(model.frames[story.plain]).toBeUndefined();
      }),
    );
  });

  it("load a flow's open step and its neighbours, once", () => {
    const step = (number: number) => `frames/flows/library-sync/fresh-device/${number}.json`;
    Story.story(
      update,
      Story.given({ ...loadedAt("#/"), frames: {} }),
      Story.message(Message.ChangedUrl({ url: urlAt(flowHref("library-sync/fresh-device", 1)) })),
      Story.Command.expectExact(
        ScrollToTop,
        LoadFrame({ path: step(1) }),
        LoadFrame({ path: step(2) }),
      ),
      Story.Command.resolveAll(
        [ScrollToTop, Message.CompletedScrollToTop()],
        [LoadFrame({ path: step(1) }), Message.LoadedFrame({ path: step(1), frame: runningFrame })],
        [LoadFrame({ path: step(2) }), Message.LoadedFrame({ path: step(2), frame: runningFrame })],
      ),
      Story.message(Message.ChangedUrl({ url: urlAt(flowHref("library-sync/fresh-device", 2)) })),
      Story.Command.expectExact(LoadFrame({ path: step(3) })),
      Story.Command.resolve(LoadFrame, Message.LoadedFrame({ path: step(3), frame: runningFrame })),
    );
  });
});

describe("copy issues", () => {
  it("list each text once with every flow step and story that shows it", () => {
    expect(
      copyIssues(atlas).map(({ issue, places }) => [issue.text, places.map(placeHref)]),
    ).toEqual([
      [
        "STORAGE_FAILURE",
        [flowHref("library-sync/fresh-device", 3), storyHref("library-sync/pushed")],
      ],
      ["Retired", [storyHref("library-sync/pushed")]],
    ]);
    expect(totals(atlas).issues).toBe(2);
  });

  it("open the first place an issue picked in the ⌘K menu appears", () => {
    const menu = (message: CommandMenu.Message) =>
      Message.Palette({ message: CommandDialog.Message.Menu({ message }) });
    Story.story(
      update,
      Story.given(loadedAt("#/")),
      Story.message(menu(CommandMenu.Message.QueryChanged({ query: "STORAGE_FAILURE" }))),
      Story.message(menu(CommandMenu.Message.Picked({ index: null }))),
      Story.Command.expectHas(NavigateTo({ url: flowHref("library-sync/fresh-device", 3) })),
      Story.Command.resolve(NavigateTo, Message.CompletedNavigation()),
    );
  });
});
