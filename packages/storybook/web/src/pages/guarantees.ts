import { commandGuarantees } from "../../../src/atlas/guarantees.ts";
export { commandGuarantees } from "../../../src/atlas/guarantees.ts";
import type { HtmlBuilder } from "foldkit/html";
import type { Atlas } from "../../../src/atlas/data.ts";
import { Message, tipOf, type Model } from "../model.ts";
import * as Accordion from "../fluid/components/accordion";
import * as Badge from "../fluid/components/badge";
import * as Tooltip from "../fluid/components/tooltip";
import * as Item from "../components/item.ts";
import * as DataList from "../components/data-list.ts";
import { flowItem } from "./flow-item.ts";
import { icon } from "../fluid/components/icons";
import { commandHref, coverageHref } from "../route.ts";

/** The section owns status aggregation; Accordion and Item receive only presentation data. */
export const guaranteesPage = (
  atlas: Atlas,
  command: string,
  selectedTest: string | undefined,
  model: Model,
  h: HtmlBuilder<Message>,
) => {
  const groups = commandGuarantees(atlas, command).filter(
    (group) =>
      selectedTest === undefined || group.tests.some(({ test }) => test.title === selectedTest),
  );
  const sections: Array<{ path: string[]; groups: typeof groups }> = [];
  for (const group of groups) {
    let section = sections.find(
      (entry) => JSON.stringify(entry.path) === JSON.stringify(group.sections),
    );
    if (section === undefined) {
      section = { path: group.sections, groups: [] };
      sections.push(section);
    }
    section.groups.push(group);
  }
  const accordion = (sectionGroups: typeof groups, index: number) =>
    h.submodel({
      slotId: `command-guarantees-${index}`,
      model: model.guarantees,
      view: Accordion.view,
      toParentMessage: (message) => Message.Guarantees({ message }),
      viewInputs: {
        id: `command-guarantees-${index}`,
        type: "multiple",
        className: "w-full! [&_.ff-accordion-body]:pt-0!",
        items: sectionGroups.map((group) => ({ value: group.key, label: group.title })),
        renderLabel: (value) => {
          const tests = sectionGroups.find((group) => group.key === value)?.tests ?? [];
          const counts = tests.reduce(
            (counts, { test }) => {
              counts[test.status ?? "no current result"]++;
              return counts;
            },
            { passed: 0, failed: 0, skipped: 0, todo: 0, "no current result": 0 },
          );
          const passed = counts.passed === tests.length;
          return h.span(
            [
              h.Class(
                "flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 text-body",
              ),
            ],
            [
              h.span(
                [h.Class("min-w-0 flex-1 text-foreground")],
                [sectionGroups.find((group) => group.key === value)?.title ?? value],
              ),
              " ",
              Badge.view(
                {
                  size: "compact",
                  tone: passed
                    ? "success"
                    : counts.failed
                      ? "destructive"
                      : counts.skipped || counts.todo
                        ? "warning"
                        : undefined,
                  children: [
                    counts["no current result"] === tests.length
                      ? `${tests.length} ${tests.length === 1 ? "test" : "tests"}`
                      : Object.entries(counts)
                          .filter(([, count]) => count > 0)
                          .map(([status, count]) => `${count} ${status}`)
                          .join(", "),
                  ],
                },
                h,
              ),
            ],
          );
        },
        renderContent: (value) => {
          const tests = (sectionGroups.find((group) => group.key === value)?.tests ?? []).filter(
            ({ test }) => selectedTest === undefined || test.title === selectedTest,
          );
          return h.div(
            [h.Class("grid min-w-0")],
            [...new Set(tests.map(({ file }) => file))].map((file) =>
              h.section(
                [h.Key(file), h.Class("grid min-w-0 gap-2 border-b-1 border-border pt-4")],
                [
                  h.h4(
                    [
                      h.Class(
                        "m-0 break-all px-3 font-mono text-caption font-body text-muted-foreground",
                      ),
                    ],
                    [file],
                  ),
                  Item.group(
                    {
                      label: `Tests in ${file}`,
                      items: tests
                        .filter((entry) => entry.file === file)
                        .map(({ test }) => {
                          const flow = atlas.flows.find((flow) => flow.name === test.title);
                          const key = JSON.stringify([file, ...test.ancestorTitles, test.title]);
                          const label = flow ? "Recorded flow" : "Test";
                          return {
                            ...(flow
                              ? flowItem(atlas, flow, h, { command, showFork: false })
                              : {
                                  title: [test.title],
                                  size: "compact" as const,
                                }),
                            key,
                            leading: h.span(
                              [
                                h.Class(
                                  "inline-flex h-5 shrink-0 items-center text-muted-foreground",
                                ),
                              ],
                              [
                                h.submodel({
                                  slotId: `tip-test-kind-${encodeURIComponent(key)}`,
                                  model: tipOf(model, `test-kind-${key}`),
                                  view: Tooltip.view,
                                  toParentMessage: (message) =>
                                    Message.Tip({ key: `test-kind-${key}`, message }),
                                  viewInputs: {
                                    content: label,
                                    side: "top",
                                    renderTrigger: (attributes) =>
                                      h.span(
                                        [
                                          ...attributes,
                                          h.Role("img"),
                                          h.AriaLabel(label),
                                          h.Class(
                                            "inline-flex size-4 items-center focus-visible:outline-2 focus-visible:outline-ring",
                                          ),
                                          // The flow anchor is the keyboard target; don't nest
                                          // a second tab stop inside it. Plain tests can focus media.
                                          ...(flow ? [] : [h.Tabindex(0)]),
                                        ],
                                        [
                                          icon(flow ? "monitor" : "check", undefined, h, {
                                            className: "size-4",
                                          }),
                                        ],
                                      ),
                                  },
                                }),
                              ],
                            ),
                            trailing: [
                              Badge.view(
                                {
                                  size: "compact",
                                  tone: !test.status
                                    ? undefined
                                    : test.status === "passed"
                                      ? "success"
                                      : test.status === "failed"
                                        ? "destructive"
                                        : "warning",
                                  children: [test.status ?? "No current result"],
                                },
                                h,
                              ),
                              // One trailing column keeps every status aligned. Only links
                              // draw a chevron; plain tests reserve its space silently.
                              h.span(
                                [h.Class("inline-flex size-4 shrink-0"), h.AriaHidden(true)],
                                flow
                                  ? [
                                      icon("chevron-right", undefined, h, {
                                        className: "size-4 text-muted-foreground",
                                      }),
                                    ]
                                  : [],
                              ),
                            ],
                          };
                        }),
                    },
                    h,
                  ),
                ],
              ),
            ),
          );
        },
      },
    });
  return h.section(
    [h.Class("grid min-w-0 gap-6")],
    [
      h.div(
        [h.Class("grid gap-2")],
        [
          ...(selectedTest === undefined
            ? []
            : [h.h2([h.Class("m-0 text-title font-heading")], [selectedTest])]),
          ...(selectedTest === undefined
            ? []
            : [
                h.a(
                  [h.Href(commandHref(command)), h.Class("w-fit underline underline-offset-4")],
                  ["All guarantees"],
                ),
              ]),
          h.p(
            [h.Class("m-0 text-muted-foreground")],
            [
              "Guarantees come from the tests in this checkout. Statuses come from matching saved runs.",
            ],
          ),
        ],
      ),
      ...(atlas.guaranteeFiles?.some((file) => file.unattached)
        ? [
            h.a(
              [h.Href(coverageHref), h.Class("w-fit underline")],
              ["View tests outside command guarantees"],
            ),
          ]
        : []),
      DataList.view(
        {
          label: "Saved test runs",
          size: "compact",
          items: ["cli", "skit"].map((pkg) => {
            const report = atlas.testReports.find((report) => report.package === pkg);
            return {
              key: pkg,
              label: [h.code([h.Class("font-mono text-caption")], [`packages/${pkg}:`])],
              value: [
                report === undefined
                  ? h.span([h.Class("text-muted-foreground")], ["No saved test report"])
                  : `${new Date(report.startTime).toISOString()}${report.provenance === "current" ? "" : ` · ${report.provenance}`}`,
              ],
            };
          }),
        },
        h,
      ),
      ...(groups.length === 0
        ? [
            h.p(
              [h.Class("m-0 text-muted-foreground")],
              [
                selectedTest === undefined
                  ? "No declared guarantees for this command"
                  : "No matching guarantee for this test",
              ],
            ),
          ]
        : []),
      ...sections.map((section, index) =>
        h.section(
          [h.Key(JSON.stringify(section.path)), h.Class("grid min-w-0 gap-2")],
          [
            ...(section.path.length === 0
              ? []
              : [h.h2([h.Class("m-0 text-title font-heading")], [section.path.join(" / ")])]),
            accordion(section.groups, index),
          ],
        ),
      ),
    ],
  );
};
