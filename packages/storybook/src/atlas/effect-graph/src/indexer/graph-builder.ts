import { relative } from "node:path";
import type * as ts from "./syntax.ts";
import type { GraphEdge, GraphLocation, GraphNode, GraphSpan, LayerGraph } from "./graph-artifact.ts";

/** The source offsets a graph node records for its expression. */
const spanOf = (node: ts.Node): GraphSpan => ({ start: node.getStart(node.getSourceFile()), end: node.getEnd() });

type NodeFields = Omit<GraphNode, "id" | "location" | "span">;

export interface GraphBuilder {
  readonly location: (source: ts.Node) => GraphLocation;
  /** A declared value's identity and place (`file:line:column`), for `GraphNode.declaration`. */
  readonly declaration: (value: ts.Node) => string;
  /** The node for a source expression of one kind. One expression expanded at
   * several call sites passes each call's `context` to keep them apart. An
   * existing node keeps its fields; use `patch` to change them. */
  readonly node: (source: ts.Node, fields: NodeFields, context?: string) => string;
  readonly patch: (id: string, fields: Partial<NodeFields>) => void;
  readonly size: () => number;
  /** One edge per (from, to, kind). A node never feeds itself: the same
   * expression reached along two paths must not invent a cycle. */
  readonly edge: (from: string, to: string, kind: GraphEdge["kind"], at: ts.Node, meaning?: GraphEdge["meaning"]) => void;
  readonly graph: () => LayerGraph;
}

export const graphBuilder = (repo: string): GraphBuilder => {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const location = (source: ts.Node): GraphLocation => {
    const file = source.getSourceFile();
    const at = file.getLineAndCharacterOfPosition(source.getStart(file));
    return { file: relative(repo, file.fileName), line: at.line + 1, column: at.character + 1 };
  };
  return {
    location,
    declaration: (value) => { const at = location(value); return `${at.file}:${at.line}:${at.column}`; },
    node: (source, fields, context = "") => {
      const span = spanOf(source);
      const where = location(source);
      const id = `${fields.kind}:${where.file}:${span.start}:${span.end}${context === "" ? "" : `@${context}`}`;
      if (!nodes.has(id)) nodes.set(id, { id, ...fields, location: where, span });
      return id;
    },
    patch: (id, fields) => {
      const node = nodes.get(id);
      if (node) nodes.set(id, { ...node, ...fields });
    },
    size: () => nodes.size,
    edge: (from, to, kind, at, meaning) => {
      const key = `${from}\0${to}\0${kind}`;
      if (from === to || edgeKeys.has(key)) return;
      edgeKeys.add(key);
      edges.push({ from, to, kind, location: location(at), ...(meaning === undefined ? {} : { meaning }) });
    },
    graph: () => ({ nodes: [...nodes.values()], edges: [...edges], extractionModel: "source-composition-v2" }),
  };
};
