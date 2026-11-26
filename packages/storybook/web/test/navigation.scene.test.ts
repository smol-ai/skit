import { Navigation } from "foldkit";
import * as Scene from "foldkit/scene";
import { Animation, Dialog as DialogPrimitive } from "@foldkit/ui";
import { describe, it } from "vitest";
import { Mounted as CommandMenuVisuals } from "../src/fluid/components/command-menu/runtime";
import * as Dialog from "../src/fluid/components/dialog";
import { ScrollArea } from "../src/fluid/components/scroll-area/runtime";
import { Mounted as TableHover } from "../src/fluid/components/table/runtime";
import { NavigateTo, ScrollToTop, update, view } from "../src/main.ts";
import { Message } from "../src/model.ts";
import { commandHref, flowHref } from "../src/route.ts";
import { atlas, loadedAt, urlAt } from "./fixture.ts";
import { settle } from "./settle.ts";

describe("the sidebar", () => {
  it("opens a command's page", () => {
    const url = urlAt(commandHref("add"));
    Scene.scene(
      { update, view },
      Scene.given(loadedAt("#/")),
      settle,
      Scene.expect(Scene.role("link", { name: "skit add" })).toHaveAttr("href", "#/commands/add"),
      // The runtime turns a click on an Atlas link into this Message.
      Scene.Subscription.emit(
        Message.ClickedLink({ request: Navigation.UrlRequest.Internal({ url }) }),
      ),
      Scene.Command.resolve(NavigateTo, Message.CompletedNavigation()),
      Scene.Subscription.emit(Message.ChangedUrl({ url })),
      // The overview's two command tables leave the page.
      Scene.Mount.expectEnded(TableHover),
      Scene.Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
      settle,
      Scene.expect(Scene.role("heading", { level: 1 })).toHaveText("skit add"),
      Scene.expect(Scene.role("link", { name: "skit add" })).toHaveAttr("aria-current", "page"),
    );
  });
});

describe("a flow", () => {
  it("steps with the arrow keys, through the steps a fork shares", () => {
    Scene.scene(
      { update, view },
      Scene.given(loadedAt(flowHref("library-sync/download-failed", 3))),
      settle,
      Scene.expect(Scene.text("3 of 3")).toExist(),
      Scene.Subscription.emit(Message.PressedArrowKey({ direction: "previous" })),
      Scene.Command.resolve(
        NavigateTo({ url: flowHref("library-sync/download-failed", 2) }),
        Message.CompletedNavigation(),
      ),
      Scene.Subscription.emit(
        Message.ChangedUrl({ url: urlAt(flowHref("library-sync/download-failed", 2)) }),
      ),
      settle,
      Scene.expect(Scene.text("2 of 3")).toExist(),
      Scene.expect(Scene.role("link", { name: "library-sync/fresh-device" })).toHaveAttr(
        "href",
        flowHref("library-sync/fresh-device", 3),
      ),
    );
  });
});

describe("the ⌘K menu", () => {
  it("jumps to the flow a search finds", () => {
    const url = urlAt(flowHref("library-sync/download-failed", 1));
    Scene.scene(
      { update, view },
      Scene.given(loadedAt("#/")),
      settle,
      Scene.expect(Scene.role("textbox", { name: "Jump to" })).toHaveAttr("readonly", ""),
      Scene.click(Scene.role("textbox", { name: "Jump to" })),
      Scene.Command.resolveAll(
        [DialogPrimitive.ShowDialog, Dialog.Message.SucceededShowDialog()],
        [Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })],
        [Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })],
      ),
      settle,
      Scene.type(Scene.role("combobox"), "download-failed"),
      Scene.expect(Scene.role("option", { name: /library-sync\/download-failed/ })).toExist(),
      Scene.keydown(Scene.role("combobox"), "Enter"),
      Scene.Command.resolveAll(
        [
          NavigateTo({ url: flowHref("library-sync/download-failed", 1) }),
          Message.CompletedNavigation(),
        ],
        [Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 2 })],
        [Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 2 })],
        [DialogPrimitive.CloseDialog, Dialog.Message.CompletedCloseDialog()],
      ),
      // The closed menu leaves the page.
      Scene.Mount.expectEnded(DialogPrimitive.AcquireResources, CommandMenuVisuals, ScrollArea),
      Scene.Subscription.emit(Message.ChangedUrl({ url })),
      Scene.Mount.expectEnded(TableHover),
      Scene.Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
      settle,
      Scene.expect(Scene.role("heading", { level: 1 })).toHaveText(atlas.flows[1]!.description),
      Scene.expect(Scene.text("1 of 3")).toExist(),
    );
  });
});
