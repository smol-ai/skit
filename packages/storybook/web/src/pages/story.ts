import type { Html, HtmlBuilder } from "foldkit/html";
import type { Atlas } from "../../../src/atlas/data.ts";
import { commandsShowing } from "../atlas.ts";
import * as PageHeader from "../components/page-header.ts";
import type { Message, Model } from "../model.ts";
import { frame, fullSize, issueLinks } from "../parts.ts";
import { commandHref } from "../route.ts";

/** One output story, in the Atlas’s selected colour mode, linked back to the commands that report it. */
export function storyPage(
  atlas: Atlas,
  story: Atlas["stories"][number],
  model: Model,
  h: HtmlBuilder<Message>,
): Html {
  const commands = commandsShowing(atlas, story.key);
  const states = atlas.contracts.flatMap((contract) =>
    contract.states
      .filter(({ stories }) => stories.includes(story.key))
      .map(({ state }) => `${state} (${contract.contract} ${contract.field ?? "state"})`),
  );
  return h.article(
    [h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body")],
    [
      PageHeader.view(
        {
          title: [h.code([h.Class("font-mono")], [story.key])],
          description: [
            commands.length === 0
              ? "No command declares this story's contract."
              : h.span(
                  [],
                  [
                    "Shows what ",
                    ...commands.flatMap((command, index) => [
                      index === 0 ? "" : ", ",
                      h.a(
                        [
                          h.Href(commandHref(command.command)),
                          h.Class(
                            "text-foreground! underline! underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring",
                          ),
                        ],
                        [`skit ${command.command}`],
                      ),
                    ]),
                    " reports",
                    states.length > 0 ? `: ${states.join(", ")}` : "",
                    ".",
                  ],
                ),
            story.exitCode ? ` Exits with ${story.exitCode}.` : "",
          ],
        },
        h,
      ),
      ...(story.scenario
        ? [
            h.div(
              [h.Class("grid min-w-0 max-w-prose gap-3")],
              [
                h.p([h.Class("m-0")], [story.scenario.initial]),
                h.p([h.Class("m-0")], [story.scenario.trigger]),
                h.p([h.Class("m-0")], [story.scenario.result]),
              ],
            ),
          ]
        : []),
      frame(model, h, story.color, story.key, {
        header: h.div(
          [h.Class("flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-1")],
          [
            h.span([h.Class("text-caption text-muted-foreground")], ["Terminal"]),
            fullSize(h, story.color, story.key),
          ],
        ),
        mark: issueLinks(model, h, story.key),
      }),
    ],
  );
}
