import type { Html, HtmlBuilder } from "foldkit/html";
import type { Atlas, SystemMap } from "../../../src/atlas/data.ts";
import * as PageHeader from "../components/page-header.ts";
import * as DataList from "../components/data-list.ts";
import * as Item from "../components/item.ts";
import * as Input from "../fluid/components/input";
import * as Table from "../fluid/components/table";
import * as Badge from "../fluid/components/badge";
import * as Accordion from "../fluid/components/accordion";
import { icon } from "../fluid/components/icons";
import { Message, type Model } from "../model.ts";
import { commandTabHref, serviceHref, storeHref, errorHref, type AppRoute } from "../route.ts";
import * as NodeGraph from "../components/node-graph.ts";
import {
  commandsRequiring,
  localServices,
  serviceAreas,
  serviceGraph,
  serviceName,
} from "./service-graph.ts";
export { localServices, serviceName } from "./service-graph.ts";

type Trace = SystemMap["commands"][number]["traces"][number];
type TracedProvider = Trace["providers"][number];
type Service = SystemMap["services"][number];

function providerDescription(
  atlas: Atlas,
  provider: TracedProvider,
  candidate: boolean,
  h: HtmlBuilder<Message>,
  detailed = false,
) {
  return h.span(
    [h.Class("block")],
    [
      ...(candidate ? ["Candidate: "] : []),
      provider.name,
      h.code(
        [h.Class("font-mono text-caption break-all")],
        [` | ${provider.file}:${provider.line}`],
      ),
      ...(candidate || detailed
        ? provider.notes.map((note) => h.span([h.Class("block text-caption")], [note]))
        : []),
      h.span(
        [h.Class("flex flex-wrap gap-x-2 gap-y-1")],
        [
          "Construction requires: ",
          ...(provider.requires.length
            ? provider.requires.map((requirement) => {
                const service = atlas.systemMap.services.find(
                  (service) => service.id === requirement.service,
                );
                return service
                  ? h.a(
                      [
                        h.Href(serviceHref(service.id)),
                        h.Class("text-foreground underline underline-offset-4"),
                      ],
                      [serviceName(service)],
                    )
                  : h.span(
                      [],
                      [`${requirement.name}${requirement.incomplete ? " (incomplete)" : ""}`],
                    );
              })
            : ["none"]),
        ],
      ),
    ],
  );
}

function traceDescription(atlas: Atlas, trace: Trace, h: HtmlBuilder<Message>, detailed = false) {
  return [
    ...trace.providers.map((provider) => providerDescription(atlas, provider, false, h, detailed)),
    ...trace.candidates.map((provider) => providerDescription(atlas, provider, true, h, detailed)),
    ...trace.stops.map((stop) =>
      h.span(
        [h.Key(`${stop.file}:${stop.line}:${stop.reason}`), h.Class("block text-warning")],
        [
          stop.reason,
          h.code([h.Class("font-mono text-caption break-all")], [` | ${stop.file}:${stop.line}`]),
        ],
      ),
    ),
  ];
}

function traceTree(
  atlas: Atlas,
  trace: Trace,
  traces: readonly Trace[],
  h: HtmlBuilder<Message>,
  ancestors: readonly string[] = [],
): Html {
  const service = atlas.systemMap.services.find((service) => service.id === trace.service);
  const cycle = ancestors.includes(trace.id);
  const children = cycle
    ? []
    : [
        ...new Set(
          [...trace.providers, ...trace.candidates].flatMap((provider) => provider.dependencies),
        ),
      ].flatMap((id) => traces.find((trace) => trace.id === id) ?? []);
  return h.div(
    [h.Key(trace.id), h.Class("grid min-w-0 gap-3")],
    [
      Item.group(
        {
          items: [
            {
              key: trace.id,
              title: [
                service
                  ? h.a(
                      [
                        h.Href(serviceHref(service.id)),
                        h.Class("text-foreground underline underline-offset-4"),
                      ],
                      [serviceName(service)],
                    )
                  : trace.name,
              ],
              size: "compact",
              description: cycle
                ? ["Requirement cycle; this chain returns to the service above."]
                : traceDescription(atlas, trace, h, true),
            },
          ],
        },
        h,
      ),
      ...(children.length
        ? [
            h.div(
              [h.Class("grid min-w-0 gap-3 border-l-1 border-border pl-4")],
              children.map((child) => traceTree(atlas, child, traces, h, [...ancestors, trace.id])),
            ),
          ]
        : []),
    ],
  );
}

export const mapDisclosures = (atlas: Atlas, route: AppRoute) => [
  ...(route._tag === "Services"
    ? [
        { value: "dependency-list", label: "Application dependencies (list)" },
        {
          value: "external-services",
          label: `External services (${atlas.systemMap.services.filter((service) => service.kind === "External requirement").length})`,
        },
        {
          value: "declared-owners",
          label: `Declared owners without a service (${atlas.systemMap.services.filter((service) => service.kind === "Owner" && !service.stores.length).length})`,
        },
      ]
    : []),
  ...(route._tag === "Service"
    ? atlas.systemMap.commands
        .filter((command) => command.traces.some((trace) => trace.service === route.id))
        .map((command) => ({
          value: `provider-chain:${command.command}`,
          label: `skit ${command.command}`,
        }))
    : []),
  {
    value: "map-stops",
    label: `Stops and partial contracts (${route._tag === "Command" ? (atlas.systemMap.commands.find((command) => command.command === route.path.replaceAll("/", " "))?.stops.length ?? 0) : atlas.systemMap.stops.length.toLocaleString("en")})`,
  },
];

function walkerStops(
  atlas: Atlas,
  model: Model,
  stops: SystemMap["stops"],
  h: HtmlBuilder<Message>,
) {
  return h.submodel({
    slotId: "map-stops",
    model: model.detailDisclosures,
    view: Accordion.view,
    toParentMessage: (message) => Message.DetailDisclosures({ message }),
    viewInputs: {
      id: "map-stops",
      type: "multiple",
      className: "w-full!",
      items: mapDisclosures(atlas, model.route),
      renderContent: () =>
        Item.group(
          {
            label: "Unresolved source boundaries",
            items: stops.map((stop) => ({
              key: `${stop.file}:${stop.line}:${stop.reason}`,
              title: [stop.reason],
              size: "compact",
              metadata: [h.code([h.Class("font-mono break-all")], [`${stop.file}:${stop.line}`])],
            })),
          },
          h,
        ),
    },
  });
}

export function servicesPage(atlas: Atlas, model: Model, h: HtmlBuilder<Message>) {
  const graph = serviceGraph(atlas);
  const reached = new Set(graph.nodes.filter((node) => node.tier === 1).map((node) => node.id));
  const query = model.serviceQuery.trim().toLowerCase();
  const matches = (service: Service) =>
    [
      serviceName(service),
      service.file,
      service.identifier,
      service.description ?? "",
      ...service.operations.map((operation) => operation.name),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  const services = localServices(atlas);
  const row = (service: Service, local: boolean): Item.Props<Message> => ({
    key: service.id,
    title: [serviceName(service)],
    href: serviceHref(service.id),
    size: "compact",
    ...(service.description
      ? {
          description: [
            h.span(
              [h.Class("block line-clamp-1"), h.Attribute("title", service.description)],
              [service.description],
            ),
          ],
        }
      : {}),
    metadata: local
      ? [reached.has(service.id) ? "Reached from CLI commands" : "Not reached by CLI tracing"]
      : [h.code([h.Class("font-mono break-all")], [service.file])],
    trailing: [
      h.span(
        [h.Class("text-caption text-muted-foreground")],
        [`${commandsRequiring(atlas, service.id).length} commands`],
      ),
      icon("chevron-right", undefined, h, { className: "size-4 text-muted-foreground" }),
    ],
  });
  return h.article(
    [
      h.Key("services-index"),
      h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body"),
    ],
    [
      PageHeader.view(
        {
          title: ["Services"],
          description: [
            "The CLI application's traced dependencies, followed by the local service declarations.",
          ],
        },
        h,
      ),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2(
            [h.Class("m-0 text-title font-heading")],
            ["CLI application (traced from the command tree)"],
          ),
          NodeGraph.view(
            {
              ...graph,
              label: "CLI application dependency diagram",
              active: model.activeServiceNode.id,
              onActive: (id, clear, input) => Message.ChangedServiceNode({ id, clear, input }),
            },
            h,
          ),
          h.p(
            [h.Class("m-0 text-caption text-muted-foreground")],
            [
              `${graph.edges.length} edges. Hover or focus a node to emphasise its direct neighbours. Dashed lines and diamonds mark stopped paths. Command groups link to Every command.`,
            ],
          ),
          h.p(
            [h.Class("m-0 text-warning")],
            ["External destinations (Registry, git, …) are not traced yet."],
          ),
          h.p(
            [h.Class("m-0 text-caption text-muted-foreground")],
            [
              "Requirements describe construction, not execution. Store edges declare ownership, not proof of access.",
            ],
          ),
          h.p(
            [h.Class("m-0 text-muted-foreground")],
            [
              `${services.length - reached.size} other local services are not reached by CLI tracing and are listed below.`,
            ],
          ),
        ],
      ),
      h.section(
        [h.Class("grid gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Local services"]),
          h.p(
            [h.Class("m-0 max-w-prose text-muted-foreground")],
            [
              "Areas come from the source module paths, largest first. Reachability is a tracing fact, not evidence that a service is unused; most unreached services are server-side, where the server walk stops at the handler.",
            ],
          ),
          Input.view(
            {
              id: "services-query",
              type: "search",
              ariaLabel: "Search services",
              placeholder: "Search services, areas and operations",
              value: model.serviceQuery,
              onInput: (query) => Message.ChangedServiceQuery({ query }),
            },
            h,
          ),
          h.p(
            [h.Class("m-0 text-caption text-muted-foreground")],
            [`${services.filter(matches).length} of ${services.length} local services`],
          ),
        ],
      ),
      ...(services.some(matches)
        ? []
        : [h.p([h.Class("m-0 text-muted-foreground")], ["No services match."])]),
      ...serviceAreas(atlas).flatMap(({ area, services }) => {
        const members = services.filter((service) => matches(service) || area.includes(query));
        return members.length
          ? [
              h.section(
                [h.Key(area), h.Class("grid min-w-0 gap-3")],
                [
                  h.h2([h.Class("m-0 text-title font-heading")], [area]),
                  Item.group(
                    { label: area, items: members.map((service) => row(service, true)) },
                    h,
                  ),
                ],
              ),
            ]
          : [];
      }),
      h.div(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.submodel({
            slotId: "services-catalogue",
            model: model.detailDisclosures,
            view: Accordion.view,
            toParentMessage: (message) => Message.DetailDisclosures({ message }),
            viewInputs: {
              id: "services-catalogue",
              type: "multiple",
              className: "w-full!",
              items: mapDisclosures(atlas, model.route),
              renderContent: (value) => {
                if (!model.detailDisclosures.expanded.includes(value)) return null;
                const edges =
                  value === "dependency-list" ? NodeGraph.layout(graph).edges : graph.edges;
                if (value === "dependency-list")
                  return h.div(
                    [h.Class("grid gap-4")],
                    graph.nodes
                      .filter((node) => edges.some((edge) => edge.from === node.id))
                      .map((node) =>
                        h.section(
                          [h.Key(node.id), h.Class("grid gap-2")],
                          [
                            h.h3(
                              [h.Class("m-0 text-body font-heading")],
                              [
                                h.a(
                                  [
                                    h.Href(node.href),
                                    h.Class("text-foreground underline underline-offset-4"),
                                  ],
                                  [node.label],
                                ),
                              ],
                            ),
                            Item.group(
                              {
                                items: edges
                                  .filter((edge) => edge.from === node.id)
                                  .flatMap((edge) => {
                                    const target = graph.nodes.find((node) => node.id === edge.to);
                                    return target
                                      ? [
                                          {
                                            key: edge.id,
                                            title: [target.label],
                                            href: target.href,
                                            size: "compact",
                                            description: [
                                              edge.label,
                                              ...(edge.stop
                                                ? [
                                                    h.span(
                                                      [h.Class("block text-warning")],
                                                      [edge.stop],
                                                    ),
                                                  ]
                                                : []),
                                            ],
                                          },
                                        ]
                                      : [];
                                  }),
                              },
                              h,
                            ),
                          ],
                        ),
                      ),
                  );
                if (value === "external-services" || value === "declared-owners")
                  return Item.group(
                    {
                      items: atlas.systemMap.services
                        .filter((service) =>
                          value === "external-services"
                            ? service.kind === "External requirement"
                            : service.kind === "Owner" && !service.stores.length,
                        )
                        .map((service) => row(service, false)),
                    },
                    h,
                  );
                return Item.group(
                  {
                    label: "Unresolved source boundaries",
                    items: atlas.systemMap.stops.map((stop) => ({
                      key: `${stop.file}:${stop.line}:${stop.reason}`,
                      title: [stop.reason],
                      size: "compact",
                      metadata: [
                        h.code([h.Class("font-mono break-all")], [`${stop.file}:${stop.line}`]),
                      ],
                    })),
                  },
                  h,
                );
              },
            },
          }),
        ],
      ),
    ],
  );
}

export function servicePage(atlas: Atlas, service: Service, model: Model, h: HtmlBuilder<Message>) {
  const names = new Map(
    atlas.systemMap.services.map((service) => [service.id, serviceName(service)]),
  );
  const errors = atlas.errors.filter((error) =>
    error.services.includes(`${service.name} (${service.file})`),
  );
  const commands = atlas.systemMap.commands.filter((command) =>
    command.traces.some((requirement) => requirement.service === service.id),
  );
  return h.article(
    [
      h.Key(service.id),
      h.Class("grid min-w-0 max-w-7xl content-start gap-8 px-6 pt-6 pb-8 text-body font-body"),
    ],
    [
      PageHeader.view({ title: [serviceName(service)], description: [service.kind] }, h),
      DataList.view(
        {
          label: "Service facts",
          items: [
            {
              key: "identifier",
              label: ["Identifier"],
              value: [h.code([h.Class("font-mono break-all")], [service.identifier])],
            },
            {
              key: "source",
              label: ["Defined at"],
              value: [
                h.code([h.Class("font-mono break-all")], [`${service.file}:${service.line}`]),
              ],
            },
            { key: "kind", label: ["Kind"], value: [service.kind] },
          ],
        },
        h,
      ),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Operations"]),
          service.operations.length
            ? Table.view(
                {
                  size: "compact",
                  children: [
                    Table.header(
                      {
                        children: [
                          Table.row(
                            {
                              children: [
                                Table.head({ children: ["Name"] }, h),
                                Table.head({ children: ["Signature"] }, h),
                              ],
                            },
                            h,
                          ),
                        ],
                      },
                      h,
                    ),
                    Table.body(
                      {
                        children: service.operations.map((operation, index) =>
                          Table.row(
                            {
                              index,
                              attributes: [
                                h.Key(`${operation.name}:${operation.file}:${operation.line}`),
                              ],
                              children: [
                                Table.cell(
                                  {
                                    children: [
                                      h.code([h.Class("font-mono")], [operation.name]),
                                      h.p(
                                        [
                                          h.Class(
                                            "m-0 text-caption text-muted-foreground break-all",
                                          ),
                                        ],
                                        [`${operation.file}:${operation.line}`],
                                      ),
                                    ],
                                  },
                                  h,
                                ),
                                Table.cell(
                                  {
                                    children: [
                                      h.code(
                                        [h.Class("font-mono wrap-anywhere whitespace-pre-wrap")],
                                        [operation.signature],
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
              )
            : h.p(
                [h.Class("m-0 text-muted-foreground")],
                [
                  service.kind === "External requirement"
                    ? "Only the external requirement's type is recorded here."
                    : "No callable operations are declared on this interface.",
                ],
              ),
        ],
      ),
      ...(commands.length
        ? [
            h.section(
              [h.Class("grid min-w-0 gap-3")],
              [
                h.h2(
                  [h.Class("m-0 text-title font-heading")],
                  ["Provider chains in command compositions"],
                ),
                h.p(
                  [h.Class("m-0 text-muted-foreground")],
                  [
                    "Each chain follows the Layers in that command's scope. Construction requirements include the Effect returning an unwrapped Layer. Unresolved parameters, alternatives and cycles stay visible.",
                  ],
                ),
                h.submodel({
                  slotId: "service-provider-chains",
                  model: model.detailDisclosures,
                  view: Accordion.view,
                  toParentMessage: (message) => Message.DetailDisclosures({ message }),
                  viewInputs: {
                    id: "service-provider-chains",
                    type: "multiple",
                    className: "w-full!",
                    items: mapDisclosures(atlas, model.route).filter((item) =>
                      item.value.startsWith("provider-chain:"),
                    ),
                    renderContent: (item) => {
                      const command = commands.find(
                        (command) => item === `provider-chain:${command.command}`,
                      );
                      return command
                        ? h.div(
                            [h.Class("grid min-w-0 gap-4")],
                            command.traces
                              .filter((trace) => trace.service === service.id)
                              .map((trace) => traceTree(atlas, trace, command.traces, h)),
                          )
                        : null;
                    },
                  },
                }),
              ],
            ),
          ]
        : []),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Named Layer definitions"]),
          h.p(
            [h.Class("m-0 max-w-prose text-muted-foreground")],
            [
              "This inventory includes aliases, compositions and fixture Layers. The command-scoped chains identify which definitions provide a command's services.",
            ],
          ),
          service.providers.length
            ? Item.group(
                {
                  label: "Provider definitions",
                  items: service.providers.map((provider) => ({
                    key: `${provider.file}:${provider.line}:${provider.name}`,
                    title: [provider.name],
                    size: "compact",
                    metadata: [
                      h.code(
                        [h.Class("font-mono break-all")],
                        [`${provider.file}:${provider.line}`],
                      ),
                    ],
                    description: [
                      h.span(
                        [h.Class("inline-flex flex-wrap gap-2")],
                        [
                          "Requires: ",
                          ...(provider.requires.length
                            ? provider.requires.map((requirement) =>
                                requirement.service
                                  ? h.a(
                                      [
                                        h.Href(serviceHref(requirement.service)),
                                        h.Class("text-foreground underline underline-offset-4"),
                                      ],
                                      [names.get(requirement.service) ?? requirement.name],
                                    )
                                  : h.span(
                                      [h.Class("text-muted-foreground")],
                                      [
                                        `${requirement.name}${requirement.incomplete ? " (incomplete)" : ""}`,
                                      ],
                                    ),
                              )
                            : ["none"]),
                        ],
                      ),
                      ...provider.notes,
                    ],
                    trailing: provider.incomplete
                      ? [
                          Badge.view(
                            { children: ["Incomplete contract"], tone: "warning", size: "compact" },
                            h,
                          ),
                        ]
                      : [],
                  })),
                },
                h,
              )
            : h.p(
                [h.Class("m-0 text-muted-foreground")],
                [
                  "No named Layer provider is resolved. Scoped injection, default values and external providers may not have a local Layer definition.",
                ],
              ),
        ],
      ),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Commands that require it"]),
          commands.length
            ? Item.group(
                {
                  items: commands.map((command) => ({
                    key: command.command,
                    title: [`skit ${command.command}`],
                    href: commandTabHref(command.command, "requirements"),
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
            : h.p(
                [h.Class("m-0 text-muted-foreground")],
                ["No pre-provision command contract names this declaration."],
              ),
        ],
      ),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2([h.Class("m-0 text-title font-heading")], ["Declared ownership"]),
          service.stores.length
            ? Item.group(
                {
                  items: service.stores.flatMap((id) => {
                    const store = atlas.persistence.find((store) => store.id === id);
                    return store
                      ? [
                          {
                            key: id,
                            title: [store.name],
                            href: storeHref(id),
                            size: "compact",
                            trailing: [
                              icon("chevron-right", undefined, h, {
                                className: "size-4 text-muted-foreground",
                              }),
                            ],
                          },
                        ]
                      : [];
                  }),
                },
                h,
              )
            : h.p(
                [h.Class("m-0 text-muted-foreground")],
                [
                  "The Persisted data catalogue names no store for this exact symbol. No ownership is inferred from a service dependency.",
                ],
              ),
        ],
      ),
      ...(errors.length
        ? [
            h.section(
              [h.Class("grid min-w-0 gap-3")],
              [
                h.h2([h.Class("m-0 text-title font-heading")], ["Catalogued interface errors"]),
                h.p(
                  [h.Class("m-0 max-w-prose text-muted-foreground")],
                  [
                    "These checked error types come from the existing Errors reader's interface declarations, independently of the incomplete command error channel.",
                  ],
                ),
                Item.group(
                  {
                    items: errors.map((error) => ({
                      key: `${error.file}/${error.name}`,
                      title: [error.name],
                      href: errorHref(`${error.file}/${error.name}`),
                      size: "compact",
                      metadata: [
                        h.code([h.Class("font-mono break-all")], [`${error.file}:${error.line}`]),
                      ],
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
          ]
        : []),
      h.p(
        [h.Class("m-0 max-w-prose text-caption text-muted-foreground")],
        [
          "Operation signatures are declarations. Error reachability is not inferred through partial channels; use the existing Errors catalogue for checked error evidence.",
        ],
      ),
    ],
  );
}

export function requirementsPage(
  atlas: Atlas,
  command: string,
  model: Model,
  h: HtmlBuilder<Message>,
) {
  const names = new Map(
    atlas.systemMap.services.map((service) => [service.id, serviceName(service)]),
  );
  const data = atlas.systemMap.commands.find((item) => item.command === command);
  if (!data)
    return h.p(
      [h.Class("m-0 text-muted-foreground")],
      ["The command's requirement contract is not resolved."],
    );
  return h.div(
    [h.Class("grid min-w-0 gap-8")],
    [
      h.p(
        [h.Class("m-0 max-w-prose text-muted-foreground")],
        [
          "Requirements are read before command providers erase them. Construction requirements include the Effect returning an unwrapped Layer. A provider origin is shown only where the composition path resolves it; this is not a complete call graph.",
        ],
      ),
      ...(data.application.length
        ? [
            h.section(
              [h.Class("grid gap-3")],
              [
                h.h3([h.Class("m-0 text-title font-heading")], ["Shared runtime providers"]),
                DataList.view(
                  {
                    label: "Shared runtime providers",
                    items: data.application.map((provider) => ({
                      key: `${provider.file}:${provider.line}`,
                      label: [provider.name],
                      value: [
                        h.code(
                          [h.Class("font-mono text-caption break-all")],
                          [`${provider.file}:${provider.line}`],
                        ),
                      ],
                    })),
                  },
                  h,
                ),
              ],
            ),
          ]
        : []),
      ...(data.incompleteErrors
        ? [
            h.p(
              [h.Class("m-0 text-warning")],
              ["The error channel is incomplete; no error list is inferred from it."],
            ),
          ]
        : []),
      Item.group(
        {
          label: "Command requirements",
          items: data.requirements.map((requirement) => ({
            key: requirement.service ?? `${requirement.file}#${requirement.name}`,
            title: [
              requirement.service
                ? h.a(
                    [
                      h.Href(serviceHref(requirement.service)),
                      h.Class("text-foreground underline underline-offset-4"),
                    ],
                    [names.get(requirement.service) ?? requirement.name],
                  )
                : requirement.name,
            ],
            size: "compact",
            metadata: [
              h.code([h.Class("font-mono break-all")], [`${requirement.file}:${requirement.line}`]),
            ],
            description: [...traceDescription(atlas, requirement, h)],
            trailing: requirement.incomplete
              ? [
                  Badge.view(
                    { children: ["Incomplete requirement"], tone: "warning", size: "compact" },
                    h,
                  ),
                ]
              : [],
          })),
        },
        h,
      ),
      ...(data.requirements.length
        ? []
        : [
            h.p(
              [h.Class("m-0 text-muted-foreground")],
              [
                "No services remain in the pre-provision contract. This does not mean the command has no side effects.",
              ],
            ),
          ]),
      h.section(
        [h.Class("grid min-w-0 gap-3")],
        [
          h.h2(
            [h.Class("m-0 text-title font-heading")],
            ["Declared ownership through required services"],
          ),
          data.stores.length
            ? Item.group(
                {
                  items: data.stores.flatMap((id) => {
                    const store = atlas.persistence.find((store) => store.id === id);
                    return store
                      ? [{ key: id, title: [store.name], href: storeHref(id), size: "compact" }]
                      : [];
                  }),
                },
                h,
              )
            : h.p(
                [h.Class("m-0 text-muted-foreground")],
                [
                  "No exact required service is a declared owner in Persisted data. Storage functions named separately are not attached by inference.",
                ],
              ),
          h.p(
            [h.Class("m-0 text-caption text-muted-foreground")],
            ["Declared ownership does not establish that this command reads or writes a store."],
          ),
        ],
      ),
      walkerStops(atlas, model, data.stops, h),
    ],
  );
}
