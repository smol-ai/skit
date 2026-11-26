import type { Atlas, SystemMap } from "../../../src/atlas/data.ts";
import type { Edge, Graph, Node } from "../components/node-graph.ts";
import { commandGroups } from "../atlas.ts";
import { commandTabHref, serviceHref, storeHref } from "../route.ts";

type Service = SystemMap["services"][number];
export const serviceName = (service: Service) =>
  service.name === "Service"
    ? (service.identifier.split("/").at(-1) ?? service.name)
    : service.name;
export const localServices = (atlas: Atlas) =>
  atlas.systemMap.services.filter(
    (service) => service.kind !== "Owner" && service.kind !== "External requirement",
  );

/** A projection of proven command/provider paths, separate from the declaration inventory. */
export function serviceGraph(atlas: Atlas): Graph {
  const definitions = new Map(atlas.systemMap.services.map((service) => [service.id, service]));
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const addService = (id: string) => {
    const service = definitions.get(id);
    if (service)
      nodes.set(id, {
        id,
        label: serviceName(service),
        detail:
          service.kind === "External requirement"
            ? atlas.systemMap.commands.some((command) =>
                command.traces.some((trace) => trace.service === id && trace.stops.length),
              )
              ? "Stopped path"
              : ""
            : `${commandsRequiring(atlas, id).length} commands`,
        href: serviceHref(id),
        tier: service.kind === "External requirement" ? 2 : 1,
      });
  };
  const edge = (from: string, to: string, label: string, stop?: string) => {
    const id = `${from}\n${to}`;
    const previous = edges.get(id);
    edges.set(id, {
      id,
      from,
      to,
      label,
      ...(stop || previous?.stop ? { stop: stop ?? previous?.stop } : {}),
    });
  };
  const requirementNode = (
    requirement: { readonly key: string; readonly name: string; readonly service?: string },
    command: string,
  ) => {
    if (requirement.service && definitions.has(requirement.service)) {
      addService(requirement.service);
      return requirement.service;
    }
    const id = `unresolved:${command}:${requirement.key}`;
    nodes.set(id, {
      id,
      label: requirement.name,
      detail: "Declaration not resolved",
      href: commandTabHref(command, "requirements"),
      tier: 2,
    });
    return id;
  };
  for (const group of commandGroups(atlas)) {
    const id = `command-group:${group.group ?? "top-level"}`;
    nodes.set(id, {
      id,
      label: group.group ?? "Top level",
      detail: `${group.commands.length} ${group.commands.length === 1 ? "command" : "commands"}`,
      href: "#/",
      tier: 0,
    });
    for (const item of group.commands) {
      const command = atlas.systemMap.commands.find((command) => command.command === item.command);
      if (!command) continue;
      for (const requirement of command.requirements) {
        const requiredId = requirementNode(requirement, command.command);
        const target = definitions.get(requiredId);
        edge(
          id,
          requiredId,
          `${group.group ?? "Top level"} requires ${target ? serviceName(target) : requirement.name}`,
          requirement.stops.map((stop) => stop.reason).join("; ") ||
            (requiredId.startsWith("unresolved:") ? "Service declaration not resolved" : undefined),
        );
      }
      for (const trace of command.traces) {
        const sourceId = requirementNode(trace, command.command);
        for (const provider of [...trace.providers, ...trace.candidates])
          for (const dependency of provider.dependencies) {
            const required = command.traces.find((trace) => trace.id === dependency);
            if (!required) continue;
            const requiredId = requirementNode(required, command.command);
            const source = definitions.get(sourceId),
              target = definitions.get(requiredId);
            edge(
              sourceId,
              requiredId,
              `${source ? serviceName(source) : trace.name} requires ${target ? serviceName(target) : required.name}`,
              sourceId === requiredId
                ? `Requires the outer ${required.name} scope; this tag represents both scopes`
                : required.stops.map((stop) => stop.reason).join("; ") ||
                    (requiredId.startsWith("unresolved:")
                      ? "Service declaration not resolved"
                      : undefined),
            );
          }
      }
    }
  }
  for (const service of atlas.systemMap.services) {
    if (!nodes.has(service.id)) continue;
    for (const id of service.stores) {
      const store = atlas.persistence.find((store) => store.id === id);
      if (!store) continue;
      const key = `store:${id}`;
      nodes.set(key, {
        id: key,
        label: store.name,
        detail: store.format,
        href: storeHref(id),
        tier: 3,
      });
      edge(service.id, key, `${serviceName(service)} declares ownership of ${store.name}`);
    }
  }
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    tiers: [
      { label: "CLI command groups", columns: 9, nodeWidth: 112 },
      { label: "SKIT services (dependency ranks)", columns: 5, nodeWidth: 192 },
      { label: "Platform and external services", columns: 6, nodeWidth: 160 },
      { label: "Saved stores (declared ownership)", columns: 5, nodeWidth: 192, nodeHeight: 80 },
    ],
  };
}

export const serviceAreas = (atlas: Atlas) =>
  [
    ...Map.groupBy(
      localServices(atlas),
      (service) => service.file.split("/src/")[1]?.split("/")[0] ?? service.file,
    ),
  ]
    .map(([area, services]) => ({ area, services }))
    .sort((a, b) => b.services.length - a.services.length || a.area.localeCompare(b.area));

/** Reachability, not just the handler's remaining environment. */
export const commandsRequiring = (atlas: Atlas, id: string) =>
  atlas.systemMap.commands.filter((command) =>
    command.traces.some((trace) => trace.service === id),
  );
