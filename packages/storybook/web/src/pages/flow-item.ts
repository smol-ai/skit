import type { HtmlBuilder } from "foldkit/html";
import type { Atlas } from "../../../src/atlas/data.ts";
import { flowPath, plural } from "../atlas.ts";
import type * as Item from "../components/item.ts";
import * as Badge from "../fluid/components/badge";
import { icon } from "../fluid/components/icons";
import { flowHref } from "../route.ts";

/** Shared recording row for command tabs and the index; Item owns its rendering. */
export function flowItem<Message>(
  atlas: Atlas,
  flow: Atlas["flows"][number],
  h: HtmlBuilder<Message>,
  context: { readonly command?: string; readonly showFork?: boolean } = {},
): Item.Props<Message> {
  const statuses = atlas.testReports
    .filter((report) => report.provenance === "current")
    .flatMap((report) => report.files.flatMap((file) => file.tests))
    .filter((test) => test.title === flow.name)
    .map((test) => test.status);
  const status = statuses.includes("failed")
    ? "failed"
    : statuses.includes("todo")
      ? "todo"
      : statuses.includes("skipped")
        ? "skipped"
        : statuses.includes("passed")
          ? "passed"
          : undefined;
  const otherCommands = flow.commands.filter((name) => name !== context.command);
  return {
    key: flow.name,
    title: [flow.description],
    href: flowHref(flow.name, 1),
    size: "compact",
    metadata: [
      h.code([h.Class("font-mono text-caption")], [flow.name]),
      ...(context.showFork !== false && flow.fork
        ? [h.span([], [`Branches from ${flow.fork.parent} after step ${flow.fork.at}`])]
        : []),
      ...(otherCommands.length
        ? [
            h.span(
              [],
              [
                context.command === undefined ? "Commands: " : "Also runs: ",
                ...otherCommands.flatMap((name, index) => [
                  index === 0 ? "" : ", ",
                  h.code([h.Class("font-mono")], [`skit ${name}`]),
                ]),
              ],
            ),
          ]
        : []),
    ],
    trailing: [
      ...(status === undefined
        ? []
        : [
            Badge.view(
              {
                size: "compact",
                tone:
                  status === "passed" ? "success" : status === "failed" ? "destructive" : "warning",
                children: [status],
              },
              h,
            ),
          ]),
      h.span(
        [h.Class("whitespace-nowrap text-caption text-muted-foreground")],
        [plural(flowPath(atlas, flow.name).length, "step")],
      ),
      icon("chevron-right", undefined, h, {
        className: "size-4 text-muted-foreground",
      }),
    ],
  };
}
