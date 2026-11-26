interface Location { readonly file: string; readonly line: number; readonly column?: number }
interface Edge { readonly from: string; readonly to: string; readonly kind: string; readonly location: Location; readonly meaning?: string }
interface Node {
  readonly id: string;
  kind: string;
  role?: string;
  typeName?: string;
  typeSource?: string;
  readonly declaration?: string;
  readonly location: Location & { readonly column: number };
}
export interface RawGraphs { readonly graphs: ReadonlyArray<{ readonly graph: { nodes: Node[]; edges: Edge[] } }> }
interface RawFact {
  readonly nodeId: string;
  readonly status: string;
  readonly reason?: string;
  carrier?: string;
  readonly role?: string;
  readonly typeName?: string;
}
export interface RawFacts { facts: RawFact[] }

/** Remove data nodes in the existing order, bridging their inputs to consumers.
 * Adjacency indexes avoid rescanning the whole graph for each removed node.
 * Map insertion order retains the previous surviving-edge/bridged-edge order. */
export const contractDataNodes = <E extends Omit<Edge, "location">>(edges: ReadonlyArray<E>, data: ReadonlySet<string>): E[] => {
  const active = new Map<number, E>(), incoming = new Map<string, Set<number>>(), outgoing = new Map<string, Set<number>>();
  let next = 0;
  const add = (edge: E) => {
    const id = next++;
    active.set(id, edge);
    if (!incoming.has(edge.to)) incoming.set(edge.to, new Set());
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, new Set());
    incoming.get(edge.to)!.add(id);
    outgoing.get(edge.from)!.add(id);
  };
  const remove = (id: number) => {
    const edge = active.get(id);
    if (!edge) return;
    active.delete(id);
    incoming.get(edge.to)!.delete(id);
    outgoing.get(edge.from)!.delete(id);
  };
  edges.forEach(add);
  for (const node of data) {
    const fed = [...(outgoing.get(node) ?? [])].map((id) => active.get(id)!);
    const made = [...(incoming.get(node) ?? [])].map((id) => active.get(id)!);
    const bridged = made.flatMap((input) => fed.filter((output) => output.to !== input.from).map((output) =>
      ({ ...input, to: output.to, kind: input.kind === "uses" ? output.kind : input.kind })));
    for (const id of [...(incoming.get(node) ?? []), ...(outgoing.get(node) ?? [])]) remove(id);
    bridged.forEach(add);
  }
  return [...active.values()];
};

/**
 * The compiler decides what is not part of the composition. An Effect a composition runs or
 * unwraps stays an effect node. Data (config, literals, options, replacements) is not a
 * node to navigate to: contract it out, so what it was made of stays attached to whatever
 * it fed, and a data-only leaf such as `fetch` disappears. A value that holds composition
 * (a CLI Command with its handlers, a handlers object) is structure and stays.
 * Mutates both the graph and its facts.
 */
export const applyCompilerFacts = (artifact: RawGraphs, facts: RawFacts): void => {
  const kinds = new Map(facts.facts.filter((fact) => fact.status === "value" || fact.status === "effect")
    .map((fact) => [fact.nodeId, fact.status]));
  // An expression the walker took for a Layer that the compiler types as an Effect keeps its
  // fact, as an effect node.
  const carriers = new Set(facts.facts.filter((fact) => fact.carrier === "effect").map((fact) => fact.nodeId));
  for (const fact of facts.facts) delete fact.carrier;
  const byNode = new Map(facts.facts.map((fact) => [fact.nodeId, fact]));
  const keptValues = new Set<string>();
  // Where each entry point is declared: a reference to one (an alchemy stack's `yield* Alerting`) is
  // how one entry runs another, never data.
  const entryPlaces = new Set(artifact.graphs.flatMap((graph) => graph.graph.nodes.filter((node) => node.kind === "root")
    .map((node) => `${node.location.file}:${node.location.line}:${node.location.column}`)));
  for (const graph of artifact.graphs) {
    const { nodes, edges } = graph.graph;
    const values = new Set<string>();
    for (const node of nodes) {
      const fact = byNode.get(node.id);
      if (fact?.role) node.role = fact.role;
      if (fact?.typeName) node.typeName = fact.typeName;
      // An entry point stays one, whatever its type.
      if (node.kind === "root") continue;
      const kind = kinds.get(node.id);
      if (fact?.role === "layer") node.kind = "layer";
      else if (kind === "effect" || carriers.has(node.id)) { node.kind = "effect"; delete node.typeSource; }
      else if (kind === "value") values.add(node.id);
    }
    const kindsById = new Map(nodes.map((node) => [node.id, node.kind]));
    const inputs = new Map<string, string[]>();
    for (const edge of edges) inputs.set(edge.to, [...(inputs.get(edge.to) ?? []), edge.from]);
    const holdsComposition = (id: string) => {
      const seen = new Set([id]);
      for (const stack = [id]; stack.length > 0;) for (const input of inputs.get(stack.pop()!) ?? []) {
        if (seen.has(input)) continue;
        seen.add(input);
        if (!values.has(input) && (kindsById.get(input) === "effect" || kindsById.get(input) === "layer")) return true;
        stack.push(input);
      }
      return false;
    };
    // What an entry point runs directly (a Worker's `yield* ClickHouseSchemaApplyWorkflow`, which
    // binds the Workflow) is never data, whatever the compiler types it as.
    const roots = new Set(nodes.filter((node) => node.kind === "root").map((node) => node.id));
    const runByRoot = new Set(edges.filter((edge) => roots.has(edge.to)).map((edge) => edge.from));
    const runsEntry = new Set(nodes.filter((node) => node.declaration && entryPlaces.has(node.declaration)).map((node) => node.id));
    const data = new Set([...values].filter((id) => !holdsComposition(id) && !runByRoot.has(id) && !runsEntry.has(id)));
    for (const node of nodes) if (values.has(node.id) && !data.has(node.id)) {
      keptValues.add(node.id);
      node.role = "carrier";
    }
    const current = contractDataNodes(edges, data);
    const unique = new Map(current.map((edge) => [`${edge.from}\0${edge.to}\0${edge.kind}\0${edge.location.file}\0${edge.location.line}`, edge]));
    graph.graph.nodes = nodes.filter((node) => !data.has(node.id));
    const byId = new Map(graph.graph.nodes.map((node) => [node.id, node]));
    graph.graph.edges = [...unique.values()].map((edge) => {
      const from = byId.get(edge.from), to = byId.get(edge.to);
      const meaning = from?.role === "callback" ? "callback"
        : ["provide", "provideMerge", "merge", "replaces"].includes(edge.kind) ? "provides"
        : to?.role === "carrier" && ["carrier", "program", "layer"].includes(from?.role ?? "") ? "contains"
        : to?.kind === "root" && from?.role === "program" ? "runs" : undefined;
      return meaning ? { ...edge, meaning } : edge;
    });
  }
  // A file outside its package's main tsconfig program (a benchmark or one-off script) is not the
  // application build, so the compiler has no verdict on it: no fact, not an unresolved one.
  const keptNodes = new Set(artifact.graphs.flatMap((graph) => graph.graph.nodes.map((node) => node.id)));
  facts.facts = facts.facts.filter((fact) => keptNodes.has(fact.nodeId)
    && (!kinds.has(fact.nodeId) || keptValues.has(fact.nodeId))
    && !fact.reason?.startsWith("source file absent from program"))
    .map((fact) => keptValues.has(fact.nodeId)
      ? { ...fact, status: "resolved", role: "carrier", provides: [], errors: [], requires: [] } : fact);
};
