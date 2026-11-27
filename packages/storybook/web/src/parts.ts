import { AsyncData } from "foldkit";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";
import { flagged, framePath } from "./atlas.ts";
import {
  terminalShell,
  terminalFrame,
  type Props as FrameProps,
} from "./components/terminal-frame.ts";
import * as Badge from "./fluid/components/badge";
import * as Button from "./fluid/components/button";
import * as Tooltip from "./fluid/components/tooltip";
import { Message, tipOf, type Model } from "./model.ts";
import { issuesHref } from "./route.ts";

/** Pieces several Atlas pages draw: terminal frames, gap and count badges, and their tooltips. */

/** Native navigation with Fluid's button visuals; missing destinations stay disabled. */
export const buttonLink = (
  h: HtmlBuilder<Message>,
  href: string | undefined,
  label: string,
  attributes: readonly Attribute<Message>[] = [],
) => {
  if (href === undefined) {
    return Button.view(
      { children: [label], variant: "tertiary", size: "compact", disabled: true },
      h,
    );
  }
  const visual = Button.decoration({ children: [label], variant: "tertiary", size: "compact" }, h);
  return h.a([...visual.attributes, h.Href(href), ...attributes], visual.children);
};

/** The terminal frame at `path` once it has loaded. */
export const frame = (
  model: Model,
  h: HtmlBuilder<Message>,
  path: string,
  label: string,
  props: Omit<FrameProps, "label"> = {},
) => {
  const selected = AsyncData.isSuccess(model.atlas)
    ? framePath(model.atlas.data, path, model.color)
    : path;
  const pending = (message: string) => {
    const content = h.p([h.Class("m-0 px-4 py-4 text-body text-muted-foreground")], [message]);
    return props.header === undefined ? content : terminalShell(h, { ...props, label }, content);
  };
  return AsyncData.match(model.frames[selected] ?? AsyncData.Idle(), {
    onIdle: () => pending(`Loading ${label}…`),
    onLoading: () => pending(`Loading ${label}…`),
    onFailure: (reason) => pending(`Could not load ${label}: ${reason}`),
    onRefreshing: (data) => terminalFrame(h, data, { ...props, label, color: model.color }),
    onStale: ({ data }) => terminalFrame(h, data, { ...props, label, color: model.color }),
    onSuccess: (data) => terminalFrame(h, data, { ...props, label, color: model.color }),
  });
};

/** Opens a frame in the full-size dialog. */
export const fullSize = (h: HtmlBuilder<Message>, path: string, title: string) =>
  Button.view(
    {
      children: ["Full size"],
      label: `Show ${title} at full size`,
      variant: "tertiary",
      size: "compact",
      className: "justify-self-start",
      onClick: Message.ClickedFullSize({ frame: path, title }),
    },
    h,
  );

/** Draws each copy issue in a frame as a link to the issues, with a tooltip saying why. */
export const issueLinks =
  (model: Model, h: HtmlBuilder<Message>, frameKey: string): FrameProps["mark"] =>
  (mark, key, children) =>
    h.submodel({
      slotId: `tip-issue-${frameKey}-${key}`,
      model: tipOf(model, `issue-${frameKey}-${key}`),
      view: Tooltip.view,
      toParentMessage: (message) => Message.Tip({ key: `issue-${frameKey}-${key}`, message }),
      viewInputs: {
        content: flagged(mark.issue),
        side: "top",
        renderTrigger: (attributes) =>
          h.a([...attributes, h.Href(issuesHref), h.Class("issue")], [...children]),
      },
    });

/** Something missing: red, so gaps stand out. */
export const gap = (h: HtmlBuilder<Message>, text: string) =>
  Badge.view({ children: [text], tone: "destructive", variant: "dot", size: "compact" }, h);

/** A badge or other trigger explained by a tooltip. `key` must be unique on the page. */
export const explained = (
  model: Model,
  h: HtmlBuilder<Message>,
  key: string,
  content: string,
  trigger: Html,
) =>
  h.submodel({
    slotId: `tip-${key}`,
    model: tipOf(model, key),
    view: Tooltip.view,
    toParentMessage: (message) => Message.Tip({ key, message }),
    viewInputs: {
      content,
      side: "top",
      renderTrigger: (attributes) =>
        h.span(
          [
            ...attributes,
            h.Class(
              "inline-flex w-fit cursor-help underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring",
            ),
            h.Tabindex(0),
          ],
          [trigger],
        ),
    },
  });
