import type { Html, HtmlBuilder } from "foldkit/html";
import type { Atlas, Step } from "../../../src/atlas/data.ts";
import { branchesAfter, flowPath, plural, unwalked } from "../atlas.ts";
import { Message, type Model } from "../model.ts";
import { buttonLink, frame, issueLinks } from "../parts.ts";
import { testHref, flowHref, storyHref } from "../route.ts";
import * as PageHeader from "../components/page-header.ts";
import * as DataList from "../components/data-list.ts";
import * as Item from "../components/item.ts";
import * as Stepper from "../components/stepper.ts";
import * as Badge from "../fluid/components/badge";
import * as Button from "../fluid/components/button";
import * as Accordion from "../fluid/components/accordion";
import { icon, type IconName } from "../fluid/components/icons";

/** Navigation uses event metadata; formatted terminal labels remain untouched. */
export const stepLabel = (step: Step) =>
  step.outcome
    ? (step.outcome.state ?? step.outcome.contract)
    : step.answer
      ? step.answer.chosen.join(", ")
      : (step.command ?? step.label);
export const stepKind = (step: Step) => {
  switch (step.event) {
    case "Command":
      return "command";
    case "StatusStarted":
    case "StatusUpdated":
    case "StatusEnded":
      return "progress";
    case "PromptShown":
      return "prompt";
    case "PromptAnswered":
      return "answer";
    case "Result":
      return "result";
    case "Note":
      return "note";
    case "Instruction":
      return "instruction";
    case "Failure":
      return "failure";
    case "Help":
      return "help";
    default:
      return step.kind;
  }
};

/** Replay owns navigation; the terminal is the same saved frame used by full-size viewing. */
export function flowPage(
  atlas: Atlas,
  flow: Atlas["flows"][number],
  step: number,
  model: Model,
  h: HtmlBuilder<Message>,
): Html {
  const path = flowPath(atlas, flow.name);
  const index = Math.min(Math.max(step, 1), path.length) - 1;
  const here = path[index];
  if (here === undefined) return h.p([h.Class("m-0")], [`${flow.name} has no steps.`]);
  const current = here.step;
  const frameTitle = `${flow.name}, step ${index + 1} of ${path.length}: ${current.label}`;
  const saved = atlas.testReports
    .filter((report) => report.provenance === "current")
    .flatMap((report) =>
      report.files.flatMap((file) => file.tests.map((test) => ({ report, file, test }))),
    )
    .find(
      ({ test }) =>
        test.title === flow.name &&
        test.ancestorTitles.length >= 2 &&
        test.ancestorTitles[0]!.startsWith("skit "),
    );
  const declaration = atlas.guaranteeFiles
    ?.flatMap((file) => file.tests)
    .find((test) => test.title === flow.name);
  const branches = branchesAfter(atlas, flow.name, index);
  const glyphs: Readonly<Record<string, IconName>> = {
    command: "monitor",
    progress: "loader",
    prompt: "message-circle",
    answer: "corner-down-left",
    result: "inbox",
    note: "pencil",
    instruction: "arrow-right",
    failure: "x",
    help: "lightbulb",
    step: "dot",
  };
  const indicator = (step: Step) => {
    const kind = stepKind(step);
    return h.span(
      [h.Role("img"), h.AriaLabel(kind), h.Attribute("title", kind)],
      [icon(glyphs[kind] ?? "dot", undefined, h, { className: "size-4" })],
    );
  };
  const row = (position: number): Stepper.Item => ({
    key: String(position),
    label: `${position + 1}. ${stepLabel(path[position]!.step)}`,
    href: flowHref(flow.name, position + 1),
    indicator: indicator(path[position]!.step),
    selected: position === index,
    ...(path[position]!.owner === flow.name
      ? {}
      : {
          annotation: h.span(
            [h.Role("img"), h.AriaLabel("Shared step"), h.Attribute("title", "Shared step")],
            [icon("link", undefined, h, { className: "size-4" })],
          ),
        }),
  });
  const groups: Stepper.Row[] = stepGroups(path).map(({ start, end }) =>
    start === end
      ? row(start)
      : {
          key: String(start),
          label: `${start + 1}–${end + 1}. ${path[end]!.step.progress} (${end - start + 1} ticks)`,
          children: path.slice(start, end + 1).map((_, offset) => row(start + offset)),
        },
  );
  const setup =
    flow._tag === "Scenario"
      ? DataList.view(
          {
            label: "Starting world",
            size: "compact",
            items: Object.entries(flow.world).map(([key, value]) => ({
              key,
              label: [flow.worldLabels[key]!],
              value: [
                Array.isArray(value)
                  ? value.join(", ")
                  : typeof value === "boolean"
                    ? value
                      ? "Yes"
                      : "No"
                    : String(value),
              ],
            })),
          },
          h,
        )
      : DataList.view(
          {
            label: "Initial and final state",
            orientation: "vertical",
            size: "compact",
            items: [
              { key: "initial", label: ["Initial state"], value: [flow.initialState] },
              { key: "final", label: ["Final state"], value: [flow.finalState] },
            ],
          },
          h,
        );
  const alternatives = current.outcome?.others ?? [];
  const answers = current.answer ? unwalked(current.answer) : [];
  return h.article(
    [h.Class("grid min-w-0 gap-6 p-6 pb-8")],
    [
      PageHeader.view(
        {
          title: [flow.description],
          description: [h.code([h.Class("font-mono text-caption")], [flow.name])],
          metadata: saved
            ? [
                h.a(
                  [
                    h.Href(
                      testHref(saved.test.ancestorTitles[0]!.slice("skit ".length), flow.name),
                    ),
                    h.AriaLabel(`Saved test ${saved.test.status}; open guarantee`),
                    h.Attribute(
                      "title",
                      `${saved.file.file} — ${new Date(saved.report.startTime).toISOString()}`,
                    ),
                    h.Class("w-fit focus-visible:outline-2 focus-visible:outline-ring"),
                  ],
                  [
                    Badge.view(
                      {
                        size: "compact",
                        tone:
                          saved.test.status === "passed"
                            ? "success"
                            : saved.test.status === "failed"
                              ? "destructive"
                              : "warning",
                        children: [saved.test.status],
                      },
                      h,
                    ),
                  ],
                ),
              ]
            : declaration
              ? [
                  h.a(
                    [
                      h.Href(
                        testHref(declaration.ancestorTitles[0]!.slice("skit ".length), flow.name),
                      ),
                      h.Class("w-fit underline"),
                    ],
                    ["Open guarantee"],
                  ),
                ]
              : [],
        },
        h,
      ),
      h.div(
        [h.Class("grid min-w-0 items-start gap-6 lg:grid-cols-3")],
        [
          h.div(
            [h.Class("grid min-w-0 gap-4 lg:col-span-2")],
            [
              h.section(
                [h.AriaLabel("Terminal replay"), h.Class("grid min-w-0")],
                [
                  frame(model, h, current.frame, frameTitle, {
                    header: h.div(
                      [
                        h.Class(
                          "flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-1",
                        ),
                      ],
                      [
                        h.span(
                          [h.Class("text-caption text-muted-foreground")],
                          [flow._tag === "Scenario" ? `Device ${flow.terminalDevice}` : "Terminal"],
                        ),
                        h.nav(
                          [h.AriaLabel("Steps"), h.Class("flex items-center gap-2")],
                          [
                            buttonLink(
                              h,
                              index > 0 ? flowHref(flow.name, index) : undefined,
                              "Previous",
                              [h.AriaKeyshortcuts("ArrowLeft")],
                            ),
                            h.span(
                              [h.AriaLive("polite"), h.Class("text-caption")],
                              [`${index + 1} of ${path.length}`],
                            ),
                            buttonLink(
                              h,
                              index < path.length - 1 ? flowHref(flow.name, index + 2) : undefined,
                              "Next",
                              [h.AriaKeyshortcuts("ArrowRight")],
                            ),
                          ],
                        ),
                        Button.view(
                          {
                            children: ["Full size"],
                            label: `Show ${frameTitle} at full size`,
                            variant: "tertiary",
                            size: "compact",
                            onClick: Message.ClickedFullSize({
                              frame: current.frame,
                              title: frameTitle,
                            }),
                          },
                          h,
                        ),
                      ],
                    ),
                    mark: issueLinks(model, h, "step"),
                  }),
                ],
              ),
              h.submodel({
                slotId: "recording-details",
                model: model.recordingDetails,
                view: Accordion.view,
                toParentMessage: (message) => Message.RecordingDetails({ message }),
                viewInputs: {
                  id: "recording-details",
                  type: "multiple",
                  className: "w-full!",
                  items: [{ value: "recording", label: "Recording setup and evidence" }],
                  renderContent: () =>
                    h.div(
                      [h.Class("grid min-w-0 gap-4")],
                      [
                        setup,
                        ...(flow.evidence
                          ? [h.p([h.Class("m-0 text-muted-foreground")], [flow.evidence])]
                          : []),
                      ],
                    ),
                },
              }),
              ...(current.issues.length
                ? [
                    h.section(
                      [h.Class("grid gap-2")],
                      [
                        h.h2([h.Class("m-0 text-title font-heading")], ["Copy issues"]),
                        Item.group(
                          {
                            items: current.issues.map((issue, i) => ({
                              key: String(i),
                              title: [issue.text],
                              description: [issue.kind],
                            })),
                          },
                          h,
                        ),
                      ],
                    ),
                  ]
                : []),
              ...(alternatives.length
                ? [
                    h.section(
                      [h.Class("grid min-w-0 gap-2")],
                      [
                        h.h2(
                          [h.Class("m-0 text-title font-heading")],
                          [`${current.outcome!.contract} can also end as`],
                        ),
                        Item.group(
                          {
                            items: alternatives.map(({ state, story }) => ({
                              key: state,
                              title: [state],
                              ...(story
                                ? { href: storyHref(story) }
                                : { description: ["No output story shows this state."] }),
                              size: "compact",
                            })),
                          },
                          h,
                        ),
                      ],
                    ),
                  ]
                : []),
              ...(answers.length
                ? [
                    h.section(
                      [h.Class("grid gap-2")],
                      [
                        h.h2(
                          [h.Class("m-0 text-title font-heading")],
                          [
                            current.answer!.kind === "multiselect"
                              ? "Left unselected, not recorded"
                              : "Other answers, not recorded",
                          ],
                        ),
                        Item.group(
                          {
                            items: answers.map((answer, i) => ({
                              key: String(i),
                              title: [answer],
                              size: "compact",
                            })),
                          },
                          h,
                        ),
                      ],
                    ),
                  ]
                : []),
              ...(branches.length
                ? [
                    h.section(
                      [h.Class("grid gap-2")],
                      [
                        h.h2(
                          [h.Class("m-0 text-title font-heading")],
                          ["Other flows go on differently"],
                        ),
                        Item.group(
                          {
                            items: branches.map((branch) => ({
                              key: branch.flow,
                              title: [branch.flow],
                              description: [stepLabel(branch.next)],
                              href: flowHref(branch.flow, index + 2),
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
          ),
          h.aside(
            [h.Class("grid min-w-0 gap-3")],
            [
              ...(flow.fork
                ? [
                    h.p(
                      [h.Class("m-0 text-caption text-muted-foreground")],
                      [
                        `First ${plural(flow.fork.at, "step")} shared with `,
                        h.a(
                          [
                            h.Href(flowHref(flow.fork.parent, flow.fork.at)),
                            h.Class("hover:underline underline-offset-4"),
                          ],
                          [flow.fork.parent],
                        ),
                        ".",
                      ],
                    ),
                  ]
                : []),
              Stepper.view({ label: "Every step", items: groups }, h),
            ],
          ),
        ],
      ),
    ],
  );
}
/** Group only adjacent progress updates of the same status; all original steps remain addressable. */
export function stepGroups(
  path: readonly { readonly step: import("../../../src/atlas/data.ts").Step }[],
) {
  const groups: { start: number; end: number }[] = [];
  for (const [index, { step }] of path.entries()) {
    const last = groups.at(-1);
    if (
      last &&
      step.kind === "progress" &&
      step.progress &&
      path[last.end]!.step.kind === "progress" &&
      path[last.end]!.step.progress === step.progress
    )
      last.end = index;
    else groups.push({ start: index, end: index });
  }
  return groups;
}
