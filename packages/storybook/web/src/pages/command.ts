import type { HtmlBuilder } from "foldkit/html";
import type { Atlas } from "../../../src/atlas/data.ts";
import { flowsRunning, plural } from "../atlas.ts";
import * as Item from "../components/item.ts";
import * as PageHeader from "../components/page-header.ts";
import * as Badge from "../fluid/components/badge";
import { icon } from "../fluid/components/icons";
import * as Card from "../fluid/components/card";
import * as Tabs from "../fluid/components/tabs";
import { Message, type Model } from "../model.ts";
import { frame } from "../parts.ts";
import { type AppRoute, type CommandTab, errorHref, flowHref, storyHref } from "../route.ts";
import { errorKey } from "./errors.ts";
import { commandGuarantees, guaranteesPage } from "./guarantees.ts";
import { requirementsPage } from "./services.ts";
import { flowItem } from "./flow-item.ts";
import { invocationPage } from "./invocation.ts";

/** A bare command keeps its default; unknown or unavailable tabs use Not found. */
export function commandTabFor(
  atlas: Atlas,
  route: Extract<AppRoute, { _tag: "Command" }>,
): CommandTab | undefined {
  const hasGuarantees = commandGuarantees(atlas, route.path.replaceAll("/", " ")).length > 0;
  const value = route.tab ?? (hasGuarantees ? "guarantees" : "results");
  const available: readonly CommandTab[] = hasGuarantees
    ? ["guarantees", "flows", "results", "errors", "invocation", "requirements"]
    : ["invocation", "results", "states", "flows", "errors", "requirements"];
  return available.find((tab) => tab === value);
}

/** The output tab's visible name is shared by its control and referring breadcrumbs. */
export function commandResultsLabel(atlas: Atlas, command: Atlas["commands"][number]): string {
  return commandGuarantees(atlas, command.command).length > 0 &&
    atlas.contracts.some(
      (contract) => command.contracts.includes(contract.contract) && contract.field === "event",
    )
    ? "Events"
    : "Results";
}

/** Every command uses the same composition; membership and wording stay in Atlas data. */
export function commandPage(
  atlas: Atlas,
  command: Atlas["commands"][number],
  model: Model,
  h: HtmlBuilder<Message>,
) {
  const contracts = atlas.contracts.filter((contract) =>
    command.contracts.includes(contract.contract),
  );
  const named = contracts.filter((contract) => contract.states.length > 0);
  const stateCount = named.reduce((sum, contract) => sum + contract.states.length, 0);
  const flows = flowsRunning(atlas, command.command);
  const hasGuarantees = commandGuarantees(atlas, command.command).length > 0;
  const stateStories = contracts.flatMap((contract) =>
    contract.states.flatMap((state) => state.stories),
  );
  const storyKeys = hasGuarantees
    ? [...new Set([...stateStories, ...command.stories])]
    : command.stories;
  const stories = storyKeys.flatMap(
    (key) => atlas.stories.find((story) => story.key === key) ?? [],
  );

  const failures = atlas.errors.filter((error) => command.errors.includes(errorKey(error)));
  const selectedTest = model.route._tag === "Command" ? model.route.test : undefined;
  const results = () =>
    stories.length === 0
      ? h.p(
          [h.Class("m-0 text-muted-foreground")],
          ["No output story shows what this command reports."],
        )
      : Card.group(
          {
            cards: stories.map((story) => {
              const prefix = `${command.command.replaceAll(" ", "-")}/`;
              const title = story.key.startsWith(prefix)
                ? story.key.slice(prefix.length)
                : story.key;
              return {
                key: story.key,
                children: [
                  Item.group(
                    {
                      items: [
                        {
                          key: story.key,
                          title: [title],
                          label: [
                            title,
                            ...(story.exitCode !== undefined && story.exitCode !== 0
                              ? [`Exit ${story.exitCode}`]
                              : []),
                            ...(story.issues.length > 0
                              ? [plural(story.issues.length, "copy issue")]
                              : []),
                          ].join(", "),
                          href: storyHref(story.key),
                          size: "compact",
                          trailing: [
                            ...(story.exitCode !== undefined && story.exitCode !== 0
                              ? [
                                  Badge.view(
                                    {
                                      tone: "destructive",
                                      size: "compact",
                                      children: [`Exit ${story.exitCode}`],
                                    },
                                    h,
                                  ),
                                ]
                              : []),
                            ...(story.issues.length > 0
                              ? [
                                  Badge.view(
                                    {
                                      tone: "warning",
                                      size: "compact",
                                      children: [plural(story.issues.length, "copy issue")],
                                    },
                                    h,
                                  ),
                                ]
                              : []),
                            icon("chevron-right", undefined, h, {
                              className: "size-4 text-muted-foreground",
                            }),
                          ],
                        },
                      ],
                    },
                    h,
                  ),
                  Card.content(
                    { children: [frame(model, h, story.color, story.key, { thumbnail: true })] },
                    h,
                  ),
                ],
              };
            }),
          },
          h,
        );

  const states = () =>
    named.length === 0
      ? h.p(
          [h.Class("m-0 text-muted-foreground")],
          ["No contract states are listed for this command."],
        )
      : Card.group(
          {
            cards: named.flatMap((contract) =>
              contract.states.map(({ state, stories: keys }) => {
                const examples = keys.flatMap(
                  (key) => atlas.stories.find((story) => story.key === key) ?? [],
                );
                return {
                  key: `${contract.contract}/${state}`,
                  children: [
                    Card.header(
                      {
                        children: [
                          Card.title({ children: [state] }, h),
                          Card.description(
                            { children: [`${contract.contract} (${contract.field ?? "state"})`] },
                            h,
                          ),
                        ],
                      },
                      h,
                    ),
                    Card.content(
                      {
                        children: [
                          ...(contract.variants ?? [])
                            .filter((variant) => variant.state === state)
                            .map((variant) =>
                              h.p(
                                [h.Key(`${variant.field}/${variant.value}`)],
                                [
                                  h.code(
                                    [h.Class("font-mono")],
                                    [`${variant.field}: ${variant.value}`],
                                  ),
                                  " — ",
                                  ...(variant.stories.length
                                    ? variant.stories.flatMap((key, index) => [
                                        index ? ", " : "Output example: ",
                                        h.a([h.Href(storyHref(key))], [key]),
                                      ])
                                    : ["No isolated output example."]),
                                  ...((variant.recordings ?? []).length
                                    ? (variant.recordings ?? []).flatMap((recording) => [
                                        " | ",
                                        h.a(
                                          [h.Href(flowHref(recording.flow, recording.step))],
                                          [`Recorded: ${recording.flow}`],
                                        ),
                                      ])
                                    : [" | No recorded workflow for this branch."]),
                                ],
                              ),
                            ),
                          ...(examples.length === 0
                            ? [h.p([], ["No output story records this state."])]
                            : examples.map((story) =>
                                h.section(
                                  [h.Key(story.key), h.Class("grid min-w-0 gap-2")],
                                  [
                                    h.a([h.Href(storyHref(story.key))], [story.key]),
                                    frame(model, h, story.color, story.key),
                                  ],
                                ),
                              )),
                        ],
                      },
                      h,
                    ),
                  ],
                };
              }),
            ),
          },
          h,
        );

  const recordings = () =>
    flows.length === 0
      ? h.p([h.Class("m-0 text-muted-foreground")], ["No recorded flow runs this command."])
      : Item.group(
          {
            label: "Recorded flows",
            items: flows.map((flow) => flowItem(atlas, flow, h, { command: command.command })),
          },
          h,
        );
  const flowList = () => {
    const unrecorded = command.scenarios?.filter((scenario) => !scenario.flow) ?? [];
    return h.section(
      [h.Class("grid min-w-0 gap-6")],
      [
        ...(command.details ?? []).map((detail) =>
          h.section(
            [h.Key(detail.title), h.Class("grid gap-2")],
            [
              h.h3([h.Class("m-0 text-title font-heading")], [detail.title]),
              h.p([h.Class("m-0")], [detail.body]),
              h.p(
                [h.Class("m-0 text-caption text-muted-foreground")],
                [h.code([h.Class("font-mono")], [detail.source])],
              ),
            ],
          ),
        ),
        recordings(),
        ...(unrecorded.length
          ? [
              h.section(
                [h.Class("grid min-w-0 gap-2")],
                [
                  h.h3([h.Class("m-0 text-body font-heading")], ["Not yet recorded"]),
                  h.p(
                    [h.Class("m-0 text-caption text-muted-foreground")],
                    [
                      "A flow count shows recordings, not how much of the command is explained. Scenarios below are reviewed examples of meaningful paths; the inventory can still grow.",
                    ],
                  ),
                  Item.group(
                    {
                      label: "Scenarios not yet recorded",
                      items: unrecorded.map((scenario) => ({
                        key: scenario.name,
                        title: [scenario.name],
                        description: [scenario.description],
                        size: "compact",
                      })),
                    },
                    h,
                  ),
                ],
              ),
            ]
          : []),
      ],
    );
  };
  const errorList = () =>
    h.section(
      [h.Class("grid min-w-0 gap-6")],
      [
        h.p(
          [h.Class("m-0 text-caption text-muted-foreground")],
          [
            "These are checked failures from the command type; failures from application providers and defects are separate.",
          ],
        ),
        ...(failures.length || command.dependencyErrors.length
          ? []
          : [h.p([h.Class("m-0")], ["This command has no checked errors."])]),
        ...(command.dependencyErrors.length
          ? [
              h.section(
                [h.Class("grid gap-2")],
                [
                  h.h3([h.Class("m-0 text-body font-heading")], ["Dependency errors"]),
                  Item.group(
                    {
                      label: "Dependency errors",
                      items: command.dependencyErrors.map((name) => ({
                        key: name,
                        title: [h.code([h.Class("font-mono")], [name])],
                        size: "compact",
                      })),
                    },
                    h,
                  ),
                ],
              ),
            ]
          : []),
        ...[...new Set(failures.map((error) => error.category))].map((category) =>
          h.section(
            [h.Key(category), h.Class("grid gap-2")],
            [
              h.h3([h.Class("m-0 text-body font-heading")], [category]),
              Item.group(
                {
                  label: category,
                  items: failures
                    .filter((error) => error.category === category)
                    .map((error) => ({
                      key: errorKey(error),
                      title: [error.name],

                      href: errorHref(errorKey(error)),
                      size: "compact",
                    })),
                },
                h,
              ),
            ],
          ),
        ),
      ],
    );
  return h.article(
    [
      h.Class(
        "grid min-w-0 max-w-7xl content-start gap-6 px-6 pt-6 pb-8 text-body font-body [&_h2]:font-heading",
      ),
    ],
    [
      PageHeader.view(
        {
          title: [h.code([h.Class("font-mono")], [`skit ${command.command}`])],
          description: [command.invocation.summary],
          children: [
            h.p(
              [h.Class("m-0 text-caption text-muted-foreground")],
              [h.code([h.Class("font-mono")], [command.invocation.usage])],
            ),
          ],
        },
        h,
      ),
      h.submodel({
        slotId: "command-tabs",
        model: model.commandTabs,
        view: Tabs.view,
        toParentMessage: (message) => Message.CommandTabs({ message }),
        viewInputs: {
          label: "Command details",
          value:
            model.route._tag === "Command"
              ? (commandTabFor(atlas, model.route) ?? "results")
              : "results",
          items: hasGuarantees
            ? [
                {
                  value: "guarantees",
                  label: "Guarantees",
                },
                { value: "flows", label: "Flows", count: flows.length },
                {
                  value: "results",
                  label: commandResultsLabel(atlas, command),
                  count: stories.length,
                },
                { value: "errors", label: "Fails with", count: failures.length },
                { value: "invocation", label: "Usage" },
                { value: "requirements", label: "Dependencies" },
              ]
            : [
                { value: "invocation", label: "Arguments & options" },
                { value: "results", label: "Results", count: stories.length },
                { value: "states", label: "States", count: stateCount },
                { value: "flows", label: "Flows", count: flows.length },
                { value: "errors", label: "Errors", count: failures.length },
                { value: "requirements", label: "Dependencies" },
              ],
          panel: (value) =>
            h.div(
              [h.Class("pt-4")],
              [
                value === "requirements"
                  ? requirementsPage(atlas, command.command, model, h)
                  : value === "guarantees"
                    ? guaranteesPage(atlas, command.command, selectedTest, model, h)
                    : value === "errors"
                      ? errorList()
                      : value === "invocation"
                        ? invocationPage(command.invocation, h)
                        : value === "states"
                          ? states()
                          : value === "flows"
                            ? flowList()
                            : results(),
              ],
            ),
        },
      }),
    ],
  );
}
