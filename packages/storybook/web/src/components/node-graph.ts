import type { HtmlBuilder } from "foldkit/html";
import * as ScrollArea from "../fluid/components/scroll-area";

/** Node graph anatomy: Grafana's Node graph panel. Native SVG, no graph library.
 * https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/node-graph/
 */
export interface Node {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly href: string;
  readonly tier: number;
}
export interface Edge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly stop?: string;
}
export interface Tier {
  readonly label: string;
  readonly columns: number;
  readonly nodeWidth: number;
  readonly nodeHeight?: number;
}
export interface Graph {
  readonly nodes: readonly Node[];
  readonly edges: readonly Edge[];
  readonly tiers: readonly Tier[];
}

/** Longest dependency ranks, then stable barycentre sweeps. Cycle edges become stops. */
export function layout(graph: Graph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const valid = graph.edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to));
  const outgoing = Map.groupBy(
    valid.filter((edge) => !edge.stop),
    (edge) => edge.from,
  );
  const reaches = (start: string, target: string) => {
    const visited = new Set<string>();
    const pending = [start];
    while (pending.length) {
      const id = pending.pop();
      if (id === target) return true;
      if (!id || visited.has(id)) continue;
      visited.add(id);
      pending.push(...(outgoing.get(id) ?? []).map((edge) => edge.to));
    }
    return false;
  };
  const edges = valid.map((edge) =>
    edge.stop || !reaches(edge.to, edge.from)
      ? edge
      : {
          ...edge,
          stop: "Dependency cycle; rank cannot continue through this edge",
        },
  );
  const forward = edges.filter((edge) => !edge.stop);
  const ranks = new Map(graph.nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let changed = false;
    for (const edge of forward) {
      if (byId.get(edge.from)?.tier !== byId.get(edge.to)?.tier) continue;
      const next = (ranks.get(edge.from) ?? 0) + 1;
      if (next > (ranks.get(edge.to) ?? 0)) {
        ranks.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = graph.tiers.flatMap((tier, index) => {
    const members = graph.nodes.filter((node) => node.tier === index);
    return [...new Set(members.map((node) => ranks.get(node.id) ?? 0))]
      .sort((a, b) => a - b)
      .flatMap((rank) => {
        const atRank = members.filter((node) => ranks.get(node.id) === rank);
        if (index !== 0) atRank.sort((a, b) => a.id.localeCompare(b.id));
        return Array.from({ length: Math.ceil(atRank.length / tier.columns) }, (_, row) => ({
          tier: index,
          nodes: atRank.slice(row * tier.columns, (row + 1) * tier.columns),
        }));
      });
  });
  const positions = new Map<string, number>();
  const order = () =>
    rows.forEach((row) =>
      row.nodes.forEach((node, index) => positions.set(node.id, (index + 0.5) / row.nodes.length)),
    );
  order();
  for (let pass = 0; pass < 4; pass++) {
    for (const row of rows) {
      const barycentre = (id: string) => {
        const neighbours = forward
          .filter((edge) => edge.to === id)
          .map((edge) => positions.get(edge.from) ?? 0.5);
        return neighbours.length
          ? neighbours.reduce((a, b) => a + b, 0) / neighbours.length
          : (positions.get(id) ?? 0.5);
      };
      row.nodes.sort((a, b) => barycentre(a.id) - barycentre(b.id) || a.id.localeCompare(b.id));
      order();
    }
  }
  const gap = 16,
    padding = 16;
  const width =
    Math.max(
      0,
      ...rows.map(
        (row) =>
          row.nodes.length * (graph.tiers[row.tier]?.nodeWidth ?? 160) +
          Math.max(0, row.nodes.length - 1) * gap,
      ),
    ) +
    padding * 2;
  let y = 0,
    previous = -1;
  const labels: Array<{ label: string; y: number }> = [];
  const nodes = rows.flatMap((row) => {
    if (row.tier !== previous) {
      y += 32;
      labels.push({ label: graph.tiers[row.tier]?.label ?? "", y: y - 12 });
      previous = row.tier;
    }
    const nodeWidth = graph.tiers[row.tier]?.nodeWidth ?? 160;
    const height = graph.tiers[row.tier]?.nodeHeight ?? 56;
    const rowWidth = row.nodes.length * (nodeWidth + gap) - gap;
    const placed = row.nodes.map((node, index) => ({
      ...node,
      x: (width - rowWidth) / 2 + index * (nodeWidth + gap),
      y,
      width: nodeWidth,
      height,
    }));
    y += height + 64;
    return placed;
  });
  return { nodes, edges, labels, rows, width, height: Math.max(0, y - 32) };
}

export interface Props<Message> extends Graph {
  readonly label: string;
  readonly active: string;
  readonly onActive: (id: string, clear: boolean, input: "pointer" | "focus") => Message;
}

export function view<Message>(props: Props<Message>, h: HtmlBuilder<Message>) {
  const drawing = layout(props);
  const nodes = new Map(drawing.nodes.map((node) => [node.id, node]));
  const neighbourhood = new Set([
    props.active,
    ...drawing.edges
      .filter((edge) => edge.from === props.active || edge.to === props.active)
      .flatMap((edge) => [edge.from, edge.to]),
  ]);
  return ScrollArea.view(
    {
      orientation: "horizontal",
      label: props.label,
      className: "w-full min-w-0 border-1 border-border",
      children: [
        h.svg(
          [
            h.Attribute("width", String(drawing.width)),
            h.Attribute("height", String(drawing.height)),
            h.Attribute("viewBox", `0 0 ${drawing.width} ${drawing.height}`),
            h.Role("group"),
            h.AriaLabel(props.label),
            h.Class("block text-caption font-body"),
          ],
          [
            ...drawing.labels.map((label) =>
              h.text(
                [
                  h.Attribute("x", "16"),
                  h.Attribute("y", String(label.y)),
                  h.Class("fill-muted-foreground font-heading"),
                ],
                [label.label],
              ),
            ),
            ...drawing.edges.flatMap((edge) => {
              const from = nodes.get(edge.from),
                to = nodes.get(edge.to);
              if (!from || !to) return [];
              const active = edge.from === props.active || edge.to === props.active;
              const x1 = from.x + from.width / 2,
                y1 = from.y + from.height,
                x2 = to.x + to.width / 2,
                y2 = to.y;
              const stopX = edge.from === edge.to ? from.x + from.width + 8 : x2;
              const stopY = edge.from === edge.to ? from.y + 16 : y2;
              const path =
                edge.from === edge.to
                  ? `M ${x1} ${y1} C ${x1 + 48} ${y1 + 48}, ${from.x + from.width + 24} ${from.y - 24}, ${stopX} ${stopY}`
                  : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
              return [
                h.path(
                  [
                    h.Key(edge.id),
                    h.AriaHidden(true),
                    h.Attribute("d", path),
                    ...(edge.stop ? [h.Attribute("stroke-dasharray", "4 4")] : []),
                    h.Class(
                      `fill-none ${active ? "stroke-info stroke-2 opacity-100" : edge.stop ? "stroke-warning stroke-1" : "stroke-border stroke-1"} ${props.active && !active ? "opacity-20" : ""}`,
                    ),
                  ],
                  [h.title([], [edge.stop ? `${edge.label}: ${edge.stop}` : edge.label])],
                ),
                ...(edge.stop
                  ? [
                      h.polygon(
                        [
                          h.Attribute(
                            "points",
                            `${stopX},${stopY - 8} ${stopX + 4},${stopY - 4} ${stopX},${stopY} ${stopX - 4},${stopY - 4}`,
                          ),
                          h.Class("fill-warning"),
                        ],
                        [],
                      ),
                    ]
                  : []),
              ];
            }),
            ...drawing.nodes.map((node) =>
              h.foreignObject(
                [
                  h.Key(node.id),
                  h.Attribute("x", String(node.x)),
                  h.Attribute("y", String(node.y)),
                  h.Attribute("width", String(node.width)),
                  h.Attribute("height", String(node.height)),
                ],
                [
                  h.a(
                    [
                      h.Href(node.href),
                      h.AriaLabel(`${node.label}${node.detail ? ` — ${node.detail}` : ""}`),
                      h.Class(
                        `flex h-full w-full flex-col items-center justify-center gap-1 border-1 bg-card px-2 text-center text-caption text-foreground focus-visible:outline-2 focus-visible:outline-ring ${props.active === node.id ? "border-ring" : "border-border"} ${props.active && !neighbourhood.has(node.id) ? "opacity-30" : "opacity-100"}`,
                      ),
                      h.OnMouseEnter(props.onActive(node.id, false, "pointer")),
                      h.OnMouseMove(props.onActive(node.id, false, "pointer")),
                      h.OnMouseLeave(props.onActive(node.id, true, "pointer")),
                      h.OnFocus(props.onActive(node.id, false, "focus")),
                      h.OnBlur(props.onActive(node.id, true, "focus")),
                    ],
                    [
                      h.strong([h.Class("font-heading")], [node.label]),
                      ...(node.detail
                        ? [h.span([h.Class("text-muted-foreground")], [node.detail])]
                        : []),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ],
    },
    h,
  );
}
