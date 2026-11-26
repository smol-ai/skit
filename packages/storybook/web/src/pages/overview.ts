import type { Html, HtmlBuilder } from "foldkit/html";
import type { Atlas } from "../../../src/atlas/data.ts";
import { commandGroups, flowsRunning, plural } from "../atlas.ts";
import * as PageHeader from "../components/page-header.ts";
import * as Badge from "../fluid/components/badge";
import * as Table from "../fluid/components/table";
import type { Message, Model } from "../model.ts";
import { explained } from "../parts.ts";
import { commandHref, flowsHref, persistenceHref } from "../route.ts";

/** Every command by group with its result stories and flows, with an explanation of the application. */
export function overview(atlas: Atlas, model: Model, h: HtmlBuilder<Message>): Html {
  let rowIndex = 0;
  return h.article(
    [h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body")],
    [
      PageHeader.view(
        {
          title: ["SKIT CLI Atlas"],
          description: [
            "Every command, the output stories that show its results, and the recorded flows that run it.",
          ],
        },
        h,
      ),
      h.section(
        [h.Class("grid min-w-0 max-w-prose gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["How SKIT works"]),
          h.p(
            [h.Class("m-0")],
            [
              "Import Collections into a Library, enable the Skills you want globally or in a repository, then let SKIT install the folders that Harnesses read. Ownership markers establish which installed folders SKIT may change.",
            ],
          ),
          h.p(
            [h.Class("m-0")],
            [
              "Author Workspaces hold editable Collections. Revisions save authored content; Releases publish immutable versions. Library sync exchanges portable Library state while installation state stays on each device.",
            ],
          ),
          h.p(
            [h.Class("m-0")],
            [
              "Open a command for its arguments, results, flows and checked errors. Explore saved formats and their owners under ",
              h.a(
                [
                  h.Href(persistenceHref),
                  h.Class(
                    "text-foreground! underline! underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring",
                  ),
                ],
                ["Persisted data"],
              ),
              ", or follow a recorded journey under ",
              h.a(
                [
                  h.Href(flowsHref),
                  h.Class(
                    "text-foreground! underline! underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring",
                  ),
                ],
                ["Flows"],
              ),
              ".",
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("min-w-0 overflow-x-auto")],
        [
          Table.view(
            {
              attributes: [h.AriaLabel("Commands")],
              children: commandGroups(atlas).map(({ group, commands }, groupIndex) =>
                Table.body(
                  {
                    attributes: [
                      h.Key(group ?? "top-level"),
                      h.AriaLabel(`${group ?? "Top-level"} commands`),
                    ],
                    children: [
                      Table.row(
                        {
                          attributes: [h.DataAttribute("table-hide-border", "true")],
                          children: [
                            Table.head(
                              {
                                className: groupIndex === 0 ? "pt-0 pb-3 pl-0" : "pt-8 pb-3 pl-0",
                                attributes: [h.Scope("rowgroup"), h.Attribute("colspan", "4")],
                                children: [
                                  h.h2(
                                    [h.Class("m-0 text-title font-heading")],
                                    [group ?? "Top level"],
                                  ),
                                ],
                              },
                              h,
                            ),
                          ],
                        },
                        h,
                      ),
                      Table.row(
                        {
                          children: ["Command", "Purpose", "Results", "Flows"].map((title, index) =>
                            Table.head(
                              {
                                className:
                                  index === 0 ? "pl-0 whitespace-nowrap" : "whitespace-nowrap",
                                attributes: [h.Scope("col")],
                                children: [title],
                              },
                              h,
                            ),
                          ),
                        },
                        h,
                      ),
                      ...commands.map((command) => {
                        const flows = flowsRunning(atlas, command.command);
                        return Table.row(
                          {
                            index: rowIndex++,
                            attributes: [h.Key(command.command)],
                            children: [
                              Table.cell(
                                {
                                  className: "pl-0 align-top",
                                  children: [
                                    h.div(
                                      [h.Class("flex items-center gap-2 whitespace-nowrap")],
                                      [
                                        h.a(
                                          [
                                            h.Href(commandHref(command.command)),
                                            h.Class(
                                              "font-mono text-foreground! underline! underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring",
                                            ),
                                          ],
                                          [`skit ${command.command}`],
                                        ),
                                        command.interactive
                                          ? Badge.view(
                                              {
                                                children: ["interactive"],
                                                tone: "info",
                                                size: "compact",
                                              },
                                              h,
                                            )
                                          : null,
                                      ],
                                    ),
                                  ],
                                },
                                h,
                              ),
                              Table.cell(
                                {
                                  className: "w-full align-top",
                                  children: [command.invocation.summary],
                                },
                                h,
                              ),
                              Table.cell(
                                {
                                  className: "whitespace-nowrap align-top",
                                  children: [
                                    command.stories.length > 0
                                      ? plural(command.stories.length, "story", "stories")
                                      : explained(
                                          model,
                                          h,
                                          `no-story-${command.command}`,
                                          "No output story shows what this command reports.",
                                          h.span([], ["no story"]),
                                        ),
                                  ],
                                },
                                h,
                              ),
                              Table.cell(
                                {
                                  className: "whitespace-nowrap align-top",
                                  children: [
                                    flows.length > 0
                                      ? plural(flows.length, "flow")
                                      : explained(
                                          model,
                                          h,
                                          `no-flow-${command.command}`,
                                          "No recorded flow runs this command.",
                                          h.span([], ["no flow"]),
                                        ),
                                  ],
                                },
                                h,
                              ),
                            ],
                          },
                          h,
                        );
                      }),
                    ],
                  },
                  h,
                ),
              ),
            },
            h,
          ),
        ],
      ),
    ],
  );
}
