import type { HtmlBuilder } from "foldkit/html";
import type { Atlas, ErrorDefinition } from "../../../src/atlas/data.ts";
import * as PageHeader from "../components/page-header.ts";
import * as Item from "../components/item.ts";
import * as DataList from "../components/data-list.ts";
import * as Accordion from "../fluid/components/accordion";
import * as Input from "../fluid/components/input";
import { icon } from "../fluid/components/icons";
import { errorExamples } from "../atlas.ts";
import { Message, type Model } from "../model.ts";
import { commandHref, errorHref, storeHref, storyHref } from "../route.ts";
import { frame } from "../parts.ts";

export const serviceLabel = (service: string) =>
  service.replace(/^Service \((.*)\.ts\)$/, "$1.Service");

export const errorKey = (error: ErrorDefinition) => `${error.file}/${error.name}`;

export function errorsPage(atlas: Atlas, model: Model, h: HtmlBuilder<Message>) {
  const query = model.errorQuery.trim().toLowerCase();
  const errors = atlas.errors.filter((error) =>
    [
      error.name,
      error.tag,
      error.file,
      error.category,
      ...error.services,
      ...errorExamples(atlas, error).map((story) => story.text),
    ]
      .join("\n")
      .toLowerCase()
      .includes(query),
  );
  return h.article(
    [h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body")],
    [
      PageHeader.view(
        {
          title: ["Errors"],
          description: [
            "Categories come from checked error types and direct source uses. Command links come from checked error types; membership does not mean every invocation emits that error.",
          ],
        },
        h,
      ),
      h.div(
        [h.Class("grid min-w-0 gap-3")],
        [
          Input.view(
            {
              id: "errors-query",
              type: "search",
              ariaLabel: "Search errors",
              placeholder: "Search categories, errors, services and user-facing text",
              value: model.errorQuery,
              onInput: (query) => Message.ChangedErrorQuery({ query }),
            },
            h,
          ),
          h.p(
            [h.Class("m-0 text-caption text-muted-foreground")],
            [`${errors.length} of ${atlas.errors.length} errors`],
          ),
          ...(errors.length === 0 ? [h.p([h.Class("m-0")], ["No errors match."])] : []),
        ],
      ),
      ...[
        ...new Set(
          errors
            .filter((error) =>
              atlas.commands.some((command) => command.errors.includes(errorKey(error))),
            )
            .map((error) => error.category),
        ),
        "Absent from command error types",
      ].flatMap((category) => {
        const absent = category === "Absent from command error types";
        const members = errors.filter((error) => {
          const linked = atlas.commands.some((command) => command.errors.includes(errorKey(error)));
          return absent ? !linked : linked && error.category === category;
        });
        return members.length === 0
          ? []
          : [
              h.section(
                [h.Key(category), h.Class("grid min-w-0 gap-3")],
                [
                  h.h2(
                    [h.Class("m-0 px-3 text-title font-heading")],
                    [`${category} (${members.length})`],
                  ),
                  Item.group(
                    {
                      label: category,
                      items: members.map((error) => ({
                        key: errorKey(error),
                        title: [error.name],
                        href: errorHref(errorKey(error)),
                        size: "compact",
                        metadata: [h.code([h.Class("font-mono")], [`${error.file}:${error.line}`])],
                        trailing: [
                          ...(absent || error.services.length
                            ? [
                                h.div(
                                  [
                                    h.Class(
                                      "grid max-w-prose gap-1 text-right text-caption text-muted-foreground",
                                    ),
                                  ],
                                  [
                                    ...(absent ? [h.p([h.Class("m-0")], [error.category])] : []),
                                    ...(error.services.length
                                      ? [
                                          h.p(
                                            [h.Class("m-0 wrap-anywhere")],
                                            [
                                              error.services
                                                .map((service) => serviceLabel(service))
                                                .join(" | "),
                                            ],
                                          ),
                                        ]
                                      : []),
                                  ],
                                ),
                              ]
                            : []),
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
            ];
      }),
    ],
  );
}

/** Source disclosures share IDs between the page and Accordion's update boundary. */
export const errorDisclosures = (
  error: ErrorDefinition,
): Array<{ value: string; label: string; source: string; file?: string }> => [
  ...error.evidence.map((use, index) => ({
    value: `evidence-${index}`,
    label: `${use.kind} | ${use.file}:${use.line}`,
    source: use.source,
  })),
  { value: "definition", label: "Definition and fields", source: error.definition },
  ...error.presentations.map((presentation, index) => ({
    value: `presentation-${index}`,
    label: `Presentation source ${presentation.file.split("/").at(-1) ?? presentation.file}`,
    file: presentation.file,
    source: presentation.source,
  })),
];

export function errorPage(
  atlas: Atlas,
  error: ErrorDefinition,
  model: Model,
  h: HtmlBuilder<Message>,
) {
  const stories = errorExamples(atlas, error);
  const disclosures = errorDisclosures(error);
  const accordion = (id: string, items: typeof disclosures) =>
    h.submodel({
      slotId: id,
      model: model.detailDisclosures,
      view: Accordion.view,
      toParentMessage: (message) => Message.DetailDisclosures({ message }),
      viewInputs: {
        id,
        type: "multiple",
        className: "w-full!",
        items,
        renderContent: (value) => {
          const item = items.find((item) => item.value === value)!;
          return h.div(
            [h.Class("grid min-w-0 gap-3")],
            [
              ...(item.file !== undefined
                ? [
                    h.p(
                      [h.Class("m-0 wrap-anywhere text-caption text-muted-foreground")],
                      [item.file],
                    ),
                  ]
                : []),
              h.pre(
                [h.Class("m-0 max-h-96 overflow-auto bg-muted p-4 text-caption")],
                [h.code([h.Class("font-mono")], [item.source])],
              ),
            ],
          );
        },
      },
    });
  const stores = atlas.persistence.filter((store) =>
    store.owners.some((owner) => owner.errors.includes(errorKey(error))),
  );
  const commands = atlas.commands.filter((command) => command.errors.includes(errorKey(error)));
  return h.article(
    [h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body")],
    [
      PageHeader.view(
        {
          title: [error.name],
          children: [
            DataList.view(
              {
                label: "Error facts",
                items: [
                  {
                    key: "source",
                    label: ["Source"],
                    value: [
                      h.code([h.Class("font-mono text-caption")], [`${error.file}:${error.line}`]),
                    ],
                  },
                  { key: "category", label: ["Category"], value: [error.category] },
                  ...(error.services.length
                    ? [
                        {
                          key: "services",
                          label: ["Service references"],
                          value: [error.services.map(serviceLabel).join(" | ")],
                        },
                      ]
                    : []),
                ],
              },
              h,
            ),
          ],
        },
        h,
      ),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2(
            [h.Class("m-0 text-title font-heading")],
            ["Commands that can fail with this error"],
          ),
          h.p(
            [h.Class("m-0 max-w-prose text-muted-foreground")],
            [
              "Read from command error types before application providers. This describes checked failures, not defects or a guarantee that an invocation reaches every case.",
            ],
          ),
          Item.group(
            {
              label: "Commands that can fail with this error",
              items: commands.map((command) => ({
                key: command.command,
                title: [`skit ${command.command}`],
                href: commandHref(command.command),
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
          ...(commands.length
            ? []
            : [
                h.p(
                  [h.Class("m-0")],
                  [
                    "Absent from all command error types. This alone does not establish dead code; defects and stored conversions use other paths.",
                  ],
                ),
              ]),
        ],
      ),
      stores.length
        ? Item.group(
            {
              label: "Stores with an owner declaring this error",
              items: stores.map((store) => ({
                key: store.id,
                title: ["Declared by an owner of ", store.name, "."],
                href: storeHref(store.id),
                size: "compact",
                trailing: [
                  icon("chevron-right", undefined, h, {
                    className: "size-4 text-muted-foreground",
                  }),
                ],
              })),
            },
            h,
          )
        : null,
      h.section(
        [h.Class("grid min-w-0 gap-4"), h.AriaLabel("CLI output")],
        [
          h.div(
            [h.Class("flex flex-wrap items-baseline justify-between gap-2")],
            [
              h.h2([h.Class("m-0 text-title font-heading")], ["CLI output"]),
              h.span(
                [h.Class("text-caption text-muted-foreground")],
                [
                  stories.length
                    ? `${stories.length} rendered ${stories.length === 1 ? "example" : "examples"}`
                    : "No rendered examples",
                ],
              ),
            ],
          ),
          h.p(
            [h.Class("m-0 text-muted-foreground")],
            ["Examples use the CLI presenter with fixture inputs."],
          ),
          ...stories.map((story) =>
            h.section(
              [h.Key(story.key), h.Class("grid min-w-0 gap-2")],
              [
                Item.view(
                  {
                    key: story.key,
                    title: [story.key.replace(/^failure\//, "")],
                    href: storyHref(story.key),
                    size: "compact",
                    trailing: [
                      icon("chevron-right", undefined, h, {
                        className: "size-4 text-muted-foreground",
                      }),
                    ],
                  },
                  h,
                ),
                frame(model, h, story.color, story.key),
              ],
            ),
          ),
        ],
      ),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Classification evidence"]),
          h.p(
            [h.Class("m-0 text-muted-foreground")],
            ["Source evidence for the category, separate from command error type membership."],
          ),
          ...(error.evidence.length
            ? [accordion("error-evidence", disclosures.slice(0, error.evidence.length))]
            : [
                h.p(
                  [h.Class("m-0")],
                  [
                    "No checked error type or direct emission found. This does not prove the definition is unused.",
                  ],
                ),
              ]),
        ],
      ),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Implementation"]),
          accordion("error-implementation", disclosures.slice(error.evidence.length)),
        ],
      ),
    ],
  );
}
