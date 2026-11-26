import type { Html, HtmlBuilder } from "foldkit/html";
import type { Atlas } from "../../../src/atlas/data.ts";
import { commandsShowing, totals } from "../atlas.ts";
import * as PageHeader from "../components/page-header.ts";
import * as Item from "../components/item.ts";
import { icon } from "../fluid/components/icons";
import * as Card from "../fluid/components/card";
import type { Message, Model } from "../model.ts";
import { explained } from "../parts.ts";
import { issuesHref, storyHref } from "../route.ts";

/** Coverage gaps and examples that no command declares. */
export function coveragePage(atlas: Atlas, model: Model, h: HtmlBuilder<Message>): Html {
  const total = totals(atlas);
  const metric = (
    key: string,
    value: string,
    label: string,
    explanation: string,
    href?: string,
  ): Card.Props<Message> => ({
    key,
    href,
    label: href === undefined ? undefined : `${value} ${label}`,
    children: [
      Card.header(
        {
          children: [
            Card.title({ children: [value] }, h),
            Card.description(
              { children: [explained(model, h, key, explanation, h.span([], [label]))] },
              h,
            ),
          ],
        },
        h,
      ),
    ],
  });
  const orphans = atlas.stories.filter((story) => commandsShowing(atlas, story.key).length === 0);
  return h.article(
    [h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body")],
    [
      PageHeader.view(
        {
          title: ["Atlas coverage"],
          description: ["What the recorded examples cover, and what still needs examples."],
        },
        h,
      ),
      h.p(
        [h.Class("m-0 max-w-prose text-caption text-muted-foreground")],
        [
          "A command appearing in a flow does not mean its important decisions are covered. Command flow tabs list reviewed scenarios and known gaps; commands without an inventory remain unreviewed.",
        ],
      ),
      Card.group(
        {
          columns: 2,
          cards: [
            metric(
              "commands-in-a-flow",
              `${total.commandsInFlow}/${total.commands}`,
              "commands in a flow",
              "Commands that at least one recorded flow runs.",
            ),
            metric(
              "named-states",
              `${total.statesWithStory}/${total.states}`,
              `named states have stories (${total.contractsWithStates} of ${total.contracts} contracts name states)`,
              "States a result names in its status or event field that an output story shows.",
            ),
            metric(
              "choices-walked",
              `${total.walked}/${total.offered}`,
              "offered prompt choices walked",
              "Choices recorded prompts offered that a flow took. The rest are branches no flow records yet.",
            ),
            metric(
              "copy-issues",
              String(total.issues),
              "distinct copy issues across flows and stories",
              "Internal identifiers, hashes, raw codes and avoided verbs in CLI prose. Required literal arguments in verified commands are allowed. Each text counts once, however many places show it.",
              issuesHref,
            ),
          ],
        },
        h,
      ),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Stories no command declares"]),
          h.p(
            [h.Class("m-0 text-muted-foreground")],
            ["Output stories whose contract no command lists, such as failures."],
          ),
          Item.group(
            {
              items: orphans.map((story) => ({
                key: story.key,
                title: [h.code([h.Class("font-mono")], [story.key])],
                label: story.key,
                href: storyHref(story.key),
                size: "compact",
                trailing: [
                  icon("chevron-right", undefined, h, {
                    className: "size-4 text-muted-foreground",
                  }),
                ],
              })),
            },
            h,
          ),
        ],
      ),
    ],
  );
}
