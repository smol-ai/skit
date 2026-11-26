import { expect, it } from "vitest";
import { layout, type Graph } from "../src/components/node-graph.ts";

const graph: Graph = {
  tiers: [
    { label: "Commands", columns: 9, nodeWidth: 112 },
    { label: "Services", columns: 5, nodeWidth: 192 },
  ],
  nodes: [
    { id: "command", label: "Command", href: "#/", tier: 0 },
    { id: "owner", label: "Owner", href: "#/owner", tier: 1 },
    { id: "storage", label: "Storage", href: "#/storage", tier: 1 },
    { id: "platform", label: "Platform", href: "#/platform", tier: 1 },
  ],
  edges: [
    { id: "a", from: "command", to: "owner", label: "requires" },
    { id: "b", from: "owner", to: "storage", label: "requires" },
    { id: "c", from: "storage", to: "platform", label: "requires" },
  ],
};

it("places requirements below every requirer and keeps all edges", () => {
  const result = layout(graph);
  for (const edge of result.edges) {
    const from = result.nodes.find((node) => node.id === edge.from);
    const to = result.nodes.find((node) => node.id === edge.to);
    expect(to?.y).toBeGreaterThan(from?.y ?? 0);
  }
  expect(result.edges).toEqual(graph.edges);
});

it("has deterministic ranks, barycentre order and coordinates", () => {
  expect(layout(graph)).toEqual(layout(graph));
  expect(
    layout({ ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() })
      .nodes,
  ).toEqual(layout(graph).nodes);
});

it("orders a rank by its parents' positions to avoid the crossed two-edge layout", () => {
  const result = layout({
    ...graph,
    nodes: [
      { id: "left", label: "Left", href: "#/", tier: 0 },
      { id: "right", label: "Right", href: "#/", tier: 0 },
      { id: "a", label: "A", href: "#/", tier: 1 },
      { id: "b", label: "B", href: "#/", tier: 1 },
    ],
    edges: [
      { id: "left-b", from: "left", to: "b", label: "requires" },
      { id: "right-a", from: "right", to: "a", label: "requires" },
    ],
  });
  expect(result.rows[1]?.nodes.map((node) => node.id)).toEqual(["b", "a"]);
});

it("keeps an empty drawing's dimensions finite and nonnegative", () => {
  const result = layout({ ...graph, nodes: [], edges: [] });
  expect(result.height).toBe(0);
  expect(result.width).toBeGreaterThanOrEqual(0);
});

it("reports a dependency cycle as stopped edges instead of increasing ranks forever", () => {
  const result = layout({
    ...graph,
    edges: [...graph.edges, { id: "cycle", from: "platform", to: "owner", label: "requires" }],
  });
  expect(result.edges.filter((edge) => edge.stop)).toHaveLength(3);
  expect(result.edges.find((edge) => edge.id === "a")?.stop).toBeUndefined();
  expect(result.nodes.every((node) => Number.isFinite(node.y))).toBe(true);
});

it("retains the source reason on an explicit same-tag scope stop", () => {
  const result = layout({
    ...graph,
    edges: [
      ...graph.edges,
      {
        id: "scope",
        from: "owner",
        to: "owner",
        label: "requires outer scope",
        stop: "Outer scope",
      },
    ],
  });
  expect(result.edges.find((edge) => edge.id === "scope")?.stop).toBe("Outer scope");
});

it("wraps a large rank inside the drawing rather than widening the page", () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    label: String(index),
    href: "#/",
    tier: 1,
  }));
  const result = layout({ ...graph, nodes, edges: [] });
  expect(result.rows.map((row) => row.nodes.length)).toEqual([5, 5, 2]);
  expect(result.width).toBe(1056);
});
