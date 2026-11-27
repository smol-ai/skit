import type { Html, HtmlBuilder } from "foldkit/html";
import type { Atlas } from "../../../src/atlas/data.ts";
import { commandGroups } from "../atlas.ts";
import * as Item from "../components/item.ts";
import * as PageHeader from "../components/page-header.ts";
import type { Message } from "../model.ts";
import { commandTabHref } from "../route.ts";
import { flowItem } from "./flow-item.ts";

/** Recordings in sidebar command order, with multi-command journeys listed once at the end. */
export function flowsPage(atlas: Atlas, h: HtmlBuilder<Message>): Html {
  const commands = commandGroups(atlas).flatMap((group) => group.commands);
  const shared = atlas.flows.filter((flow) => flow.commands.length > 1);
  return h.article(
    [h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body")],
    [
      PageHeader.view({ title: ["Flows"], description: ["Recorded command journeys."] }, h),
      ...commands.flatMap((command) => {
        const flows = atlas.flows.filter(
          (flow) => flow.commands.length === 1 && flow.commands[0] === command.command,
        );
        return flows.length === 0
          ? []
          : [
              h.section(
                [h.Key(command.command), h.Class("grid min-w-0 gap-3")],
                [
                  h.h2(
                    [h.Class("m-0 px-3 text-title font-heading")],
                    [
                      h.a(
                        [
                          h.Href(commandTabHref(command.command, "flows")),
                          h.Class(
                            "text-foreground! underline! underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring",
                          ),
                        ],
                        [h.code([h.Class("font-mono")], [`skit ${command.command}`])],
                      ),
                    ],
                  ),
                  Item.group(
                    {
                      label: `Flows for skit ${command.command}`,
                      items: flows.map((flow) =>
                        flowItem(atlas, flow, h, { command: command.command, showFork: false }),
                      ),
                    },
                    h,
                  ),
                ],
              ),
            ];
      }),
      ...(shared.length === 0
        ? []
        : [
            h.section(
              [h.Class("grid min-w-0 gap-3")],
              [
                h.h2([h.Class("m-0 px-3 text-title font-heading")], ["Multiple commands"]),
                Item.group(
                  {
                    label: "Flows with multiple commands",
                    items: shared.map((flow) => flowItem(atlas, flow, h, { showFork: false })),
                  },
                  h,
                ),
              ],
            ),
          ]),
    ],
  );
}
