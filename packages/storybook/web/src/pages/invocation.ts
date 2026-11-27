import type { Html, HtmlBuilder } from "foldkit/html";
import type { Atlas } from "../../../src/atlas/data.ts";
import type { Message } from "../model.ts";
import * as Table from "../fluid/components/table";

/** Invocation rules come from command definitions; this page only arranges their documentation. */
export function invocationPage(
  invocation: Atlas["commands"][number]["invocation"],
  h: HtmlBuilder<Message>,
): Html {
  const placeholder = (parameter: Atlas["commands"][number]["invocation"]["arguments"][number]) => {
    const name = parameter.valueName ?? parameter.type;
    return name.startsWith("<") && name.endsWith(">") ? name : `<${name}>`;
  };
  let rowIndex = 0;
  const rows = (parameters: Atlas["commands"][number]["invocation"]["arguments"], flags: boolean) =>
    parameters.map((parameter) => {
      const booleanOption = flags && parameter.type === "boolean";
      const commonDefault = booleanOption
        ? parameter.default.status === "value" && parameter.default.value === "false"
        : parameter.default.status === "none";
      const shownChoices =
        flags && !booleanOption && parameter.valueName !== undefined
          ? placeholder(parameter).slice(1, -1).split("|")
          : [];
      const choicesAlreadyShown =
        shownChoices.length > 0 &&
        parameter.choices !== undefined &&
        parameter.choices.length === shownChoices.length &&
        parameter.choices.every((choice, at) => choice === shownChoices[at]);
      return Table.row(
        {
          index: rowIndex++,
          children: [
            Table.cell(
              {
                // Authored placeholders that already list every choice may wrap;
                // keep the same condition that omits the duplicate Values line.
                className: choicesAlreadyShown
                  ? "pl-0 whitespace-normal"
                  : "pl-0 whitespace-nowrap",
                children: [
                  h.code(
                    [h.Class("font-mono")],
                    choicesAlreadyShown
                      ? [
                          `--${parameter.name}${parameter.optionalValue === undefined ? " <" : "[=<"}`,
                          ...parameter.choices.flatMap((choice, index) =>
                            index === 0 ? [choice] : ["|", h.wbr([]), choice],
                          ),
                          parameter.optionalValue === undefined ? ">" : ">]",
                        ]
                      : [
                          flags
                            ? `--${parameter.name}${parameter.type === "boolean" ? "" : parameter.optionalValue === undefined ? ` ${placeholder(parameter)}` : `[=${placeholder(parameter)}]`}`
                            : `<${parameter.name}>`,
                        ],
                  ),
                  ...parameter.aliases.map((alias) =>
                    h.p([], [h.code([h.Class("font-mono")], [alias])]),
                  ),
                ],
              },
              h,
            ),
            Table.cell(
              {
                className: "w-full",
                children: [
                  h.div(
                    [h.Class("grid min-w-0 gap-1")],
                    [
                      h.p([], [parameter.description || "Description is not defined."]),
                      ...(booleanOption ||
                      (flags && placeholder(parameter) === `<${parameter.type}>`)
                        ? []
                        : [h.p([h.Class("text-muted-foreground")], [`Type: ${parameter.type}`])]),
                      ...(parameter.choices && !choicesAlreadyShown
                        ? [
                            h.p(
                              [],
                              [
                                "Values: ",
                                h.code([h.Class("font-mono")], [parameter.choices.join(" | ")]),
                              ],
                            ),
                          ]
                        : []),
                      ...(parameter.negation
                        ? [
                            h.p(
                              [],
                              [
                                parameter.globalKind === "action"
                                  ? "Boolean false: "
                                  : "Set false: ",
                                h.code([h.Class("font-mono")], [parameter.negation]),
                              ],
                            ),
                          ]
                        : []),
                      ...(parameter.optionalValue === undefined
                        ? []
                        : [
                            h.p(
                              [],
                              [
                                "When used without a value: ",
                                h.code([h.Class("font-mono")], [parameter.optionalValue]),
                              ],
                            ),
                          ]),
                      ...(parameter.shadowedTokens?.length
                        ? [
                            h.p(
                              [],
                              [
                                "At this command, ",
                                h.code(
                                  [h.Class("font-mono")],
                                  [parameter.shadowedTokens.join(", ")],
                                ),
                                " uses the command option instead of the global option.",
                              ],
                            ),
                            ...(parameter.beforeCommandExample
                              ? [
                                  h.p(
                                    [],
                                    [
                                      "Global form: ",
                                      h.code(
                                        [h.Class("font-mono")],
                                        [parameter.beforeCommandExample],
                                      ),
                                    ],
                                  ),
                                ]
                              : []),
                          ]
                        : []),
                      ...(parameter.globalKind === "action"
                        ? [
                            h.p(
                              [h.Class("text-muted-foreground")],
                              [
                                parameter.type === "boolean"
                                  ? "Supplying this flag invokes the global action, even with false."
                                  : "Runs a global action before the command.",
                              ],
                            ),
                          ]
                        : []),
                      ...parameter.missing
                        .filter((message) => message !== "Description is not defined.")
                        .map((message) => h.p([h.Class("text-muted-foreground")], [message])),
                    ],
                  ),
                ],
              },
              h,
            ),
            Table.cell(
              {
                className: "whitespace-nowrap",
                children: [
                  h.div(
                    [h.Class("grid min-w-0 gap-1")],
                    [
                      ...(parameter.required ? [h.p([], ["Required"])] : []),
                      ...(parameter.repeated
                        ? [
                            h.p(
                              [],
                              [`${parameter.min}–${parameter.max ?? "unlimited"} occurrences`],
                            ),
                          ]
                        : []),
                      ...(commonDefault
                        ? []
                        : [
                            h.p(
                              [],
                              [
                                parameter.default.status === "value"
                                  ? "Parser default: "
                                  : parameter.default.status === "none"
                                    ? "No parser default"
                                    : "Parser default unavailable",
                                ...(parameter.default.value === undefined
                                  ? []
                                  : [h.code([h.Class("font-mono")], [parameter.default.value])]),
                              ],
                            ),
                          ]),
                    ],
                  ),
                ],
              },
              h,
            ),
          ],
        },
        h,
      );
    });
  const sections = [
    { title: "Arguments", parameters: invocation.arguments, flags: false },
    ...(["local", "inherited", "global"] as const).map((scope) => ({
      title:
        scope === "local"
          ? "Command options"
          : scope === "inherited"
            ? "Inherited options"
            : "Global options",
      parameters: invocation.options.filter((option) => option.scope === scope),
      flags: true,
    })),
  ].filter((section) => section.parameters.length > 0);
  return h.div(
    [h.Class("grid min-w-0 gap-6")],
    [
      h.div(
        [h.Class("grid min-w-0 gap-1")],
        [
          h.p(
            [h.Class("m-0 text-caption text-muted-foreground")],
            [
              "Unless a row says otherwise, parameters are optional and accept one occurrence. Boolean options have a parser default of false; other parameters have no parser default.",
            ],
          ),
          ...(invocation.arguments.length === 0
            ? [h.p([h.Class("text-muted-foreground")], ["No positional arguments."])]
            : []),
          ...invocation.missing.map((message) =>
            h.p([h.Class("text-muted-foreground")], [message]),
          ),
        ],
      ),
      h.div(
        [h.Class("grid min-w-0 gap-8")],
        [
          h.div(
            [h.Class("overflow-x-auto")],
            [
              Table.view(
                {
                  attributes: [h.AriaLabel("Arguments and options")],
                  children: [
                    Table.header(
                      {
                        children: [
                          Table.row(
                            {
                              children: [
                                Table.head(
                                  {
                                    className: "pl-0",
                                    children: ["Parameter"],
                                    attributes: [h.Attribute("scope", "col")],
                                  },
                                  h,
                                ),
                                Table.head(
                                  {
                                    className: "w-full",
                                    children: ["Meaning and accepted values"],
                                    attributes: [h.Attribute("scope", "col")],
                                  },
                                  h,
                                ),
                                Table.head(
                                  {
                                    children: ["Rules"],
                                    attributes: [h.Attribute("scope", "col")],
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
                    ...sections.map((section) =>
                      Table.body(
                        {
                          attributes: [h.AriaLabel(section.title)],
                          children: [
                            Table.row(
                              {
                                attributes: [h.DataAttribute("table-hide-border", "true")],
                                children: [
                                  Table.head(
                                    {
                                      className: "pt-8 pb-3 pl-0 text-title font-heading",
                                      attributes: [
                                        h.Attribute("scope", "rowgroup"),
                                        h.Attribute("colspan", "3"),
                                      ],
                                      children: [section.title],
                                    },
                                    h,
                                  ),
                                ],
                              },
                              h,
                            ),
                            ...rows(section.parameters, section.flags),
                          ],
                        },
                        h,
                      ),
                    ),
                  ],
                },
                h,
              ),
            ],
          ),
          ...(invocation.handlerRules.length
            ? [
                h.section(
                  [h.Class("grid min-w-0 gap-3")],
                  [
                    h.h2([h.Class("text-title")], ["Handler checks"]),
                    h.p(
                      [h.Class("text-muted-foreground")],
                      ["These checks run after argument and option parsing."],
                    ),
                    ...invocation.handlerRules.map((rule) => h.p([], [rule])),
                  ],
                ),
              ]
            : []),
          ...(invocation.examples.length
            ? [
                h.section(
                  [h.Class("grid min-w-0 gap-3")],
                  [
                    h.h2([h.Class("text-title")], ["Examples"]),
                    ...invocation.examples.map((example) =>
                      h.p([], [h.code([h.Class("font-mono")], [example])]),
                    ),
                  ],
                ),
              ]
            : []),
        ],
      ),
    ],
  );
}
