import type { Html, HtmlBuilder } from "foldkit/html";
import type { Atlas } from "../../../src/atlas/data.ts";
import { copyIssues, flagged } from "../atlas.ts";
import * as DataList from "../components/data-list.ts";
import * as Item from "../components/item.ts";
import * as PageHeader from "../components/page-header.ts";
import * as Card from "../fluid/components/card";
import { icon } from "../fluid/components/icons";
import * as Table from "../fluid/components/table";
import type { Message, Model } from "../model.ts";
import { frame } from "../parts.ts";
import { overviewHref, placeHref } from "../route.ts";

/** Every copy issue once, with each flow step and story that shows it. */
export function issuesPage(atlas: Atlas, h: HtmlBuilder<Message>): Html {
  const issues = copyIssues(atlas);
  return h.article(
    [h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body")],
    [
      PageHeader.view(
        {
          title: ["Copy issues"],
          description: [
            "Internal identifiers, hashes, raw codes and avoided verbs in CLI prose. Required literal arguments in verified commands are allowed. Each issue is listed once, with every flow step that first shows it and every story that shows it.",
          ],
        },
        h,
      ),
      issues.length === 0
        ? h.p([h.Class("m-0 text-muted-foreground")], ["No flow or story shows a copy issue."])
        : h.div(
            [h.Class("min-w-0 overflow-x-auto")],
            [
              Table.view(
                {
                  attributes: [h.AriaLabel("Copy issues")],
                  children: [
                    Table.header(
                      {
                        children: [
                          Table.row(
                            {
                              children: ["Text", "Why", "Where"].map((title) =>
                                Table.head({ attributes: [h.Scope("col")], children: [title] }, h),
                              ),
                            },
                            h,
                          ),
                        ],
                      },
                      h,
                    ),
                    Table.body(
                      {
                        children: issues.map(({ issue, places }, index) =>
                          Table.row(
                            {
                              index,
                              attributes: [h.Key(issue.text)],
                              children: [
                                Table.cell(
                                  {
                                    className: "align-top",
                                    children: [h.code([h.Class("font-mono")], [issue.text])],
                                  },
                                  h,
                                ),
                                Table.cell(
                                  { className: "align-top", children: [flagged(issue)] },
                                  h,
                                ),
                                Table.cell(
                                  {
                                    className: "p-0 align-top",
                                    children: [
                                      Item.group(
                                        {
                                          items: places.map((place) => ({
                                            key: placeHref(place),
                                            href: placeHref(place),
                                            title: [
                                              place.kind === "step"
                                                ? `${place.flow}, step ${place.step}: ${place.label}`
                                                : `Story ${place.key}`,
                                            ],
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
                                  },
                                  h,
                                ),
                              ],
                            },
                            h,
                          ),
                        ),
                      },
                      h,
                    ),
                  ],
                },
                h,
              ),
            ],
          ),
    ],
  );
}

const examples = (
  model: Model,
  h: HtmlBuilder<Message>,
  list: readonly Atlas["frames"][number][],
) =>
  Card.group(
    {
      cards: list.map((example) => ({
        key: `${example.name}:${example.width}`,
        children: [
          Card.header(
            {
              children: [
                h.h3(
                  [h.Class("m-0 text-title font-heading")],
                  [`${example.name} (${example.width} columns)`],
                ),
              ],
            },
            h,
          ),
          Card.content(
            {
              children: [
                frame(model, h, example.color, `${example.name} at ${example.width} columns`),
              ],
            },
            h,
          ),
        ],
      })),
    },
    h,
  );

/** The source-written domain definitions and verbs. */
export function vocabularyPage(atlas: Atlas, h: HtmlBuilder<Message>): Html {
  return h.article(
    [h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body")],
    [
      PageHeader.view(
        {
          title: ["Vocabulary"],
          description: ["Domain definitions and verbs from CONTEXT.md."],
        },
        h,
      ),
      ...[...new Set(atlas.vocabulary.map((entry) => entry.group))].map((group) =>
        h.section(
          [h.Key(group), h.Class("grid min-w-0 gap-3")],
          [
            h.h2([h.Class("m-0 text-title font-heading")], [group]),
            DataList.view(
              {
                orientation: "vertical",
                items: atlas.vocabulary
                  .filter((entry) => entry.group === group)
                  .map((entry) => ({
                    key: entry.term,
                    label: [h.strong([h.Class("text-foreground font-heading")], [entry.term])],
                    value: [
                      h.div(
                        [h.Class("grid min-w-0 max-w-prose gap-1")],
                        [
                          h.p([h.Class("m-0")], [entry.meaning]),
                          ...(entry.avoid
                            ? [
                                h.p(
                                  [h.Class("m-0 text-caption text-muted-foreground")],
                                  [`Avoid: ${entry.avoid}`],
                                ),
                              ]
                            : []),
                        ],
                      ),
                    ],
                  })),
              },
              h,
            ),
          ],
        ),
      ),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Verbs"]),
          DataList.view(
            {
              orientation: "vertical",
              items: atlas.verbs.map((entry) => ({
                key: entry.verb,
                label: [h.strong([h.Class("text-foreground font-heading")], [entry.verb])],
                value: [h.p([h.Class("m-0 max-w-prose")], [entry.meaning])],
              })),
            },
            h,
          ),
        ],
      ),
    ],
  );
}

/** Existing umbrella name from the former Vocabulary lead. */
export const terminalOutputVocabularyTitle = "Terminal output vocabulary";

/** The CLI's frame and Block examples, in their recorded order. */
export function terminalOutputVocabularyPage(
  atlas: Atlas,
  model: Model,
  h: HtmlBuilder<Message>,
): Html {
  return h.article(
    [h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body")],
    [
      PageHeader.view({ title: [terminalOutputVocabularyTitle] }, h),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Terminal frames"]),
          h.p(
            [h.Class("m-0 max-w-prose text-muted-foreground")],
            [
              "What the CLI draws around output: command lines, notes, steps, the status line, prompts and failures. Drawn by the same replay as the flows.",
            ],
          ),
          examples(model, h, atlas.frames),
        ],
      ),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Blocks"]),
          h.p(
            [h.Class("m-0 max-w-prose text-muted-foreground")],
            [
              "The Block vocabulary (terminal/blocks.ts). Presenters say which Block something is; renderBlocks owns every glyph, indent and colour.",
            ],
          ),
          examples(model, h, atlas.blocks),
        ],
      ),
    ],
  );
}

export const notFoundPage = (h: HtmlBuilder<Message>, what: string) =>
  h.article(
    [h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body")],
    [
      PageHeader.view(
        {
          title: ["Not in the Atlas"],
          description: [
            `The Atlas has no ${what}. `,
            h.a(
              [
                h.Href(overviewHref),
                h.Class(
                  "text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring",
                ),
              ],
              ["See every command"],
            ),
            ".",
          ],
        },
        h,
      ),
    ],
  );
