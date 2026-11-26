import type { GraphEdge, GraphNode, LayerGraph } from "./graph-artifact.ts";

/**
 * The walker expands a function's body once per call, so the same source
 * expression appears once per call context; and it makes a node at every place
 * a name is written. Where the copies are the same (same kind, label and
 * inputs, all the way down) they are one Layer drawn several times: fold them
 * into one node. Copies whose bindings differ (a helper handed different Layers
 * at two calls) have different inputs and stay apart.
 */
/** A name the application writes: its source text is its label. A call is
 * labelled by its callee but spans its arguments, and two calls are two Layers. */
const isReference = (node: GraphNode): boolean => (node.reference === "module" || node.reference === "local" || node.reference === "external")
  && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(node.label)
  && node.span !== undefined && node.span.end - node.span.start === node.label.length;

/** A reference and the initializer it resolves to are one Layer: the reference
 * takes the initializer's inputs (`Global.node` absorbs `makeGlobalNode({...})`).
 * Once only, so the initializer's own inputs stay beneath the name; but where
 * the initializer is a call the walker expanded, what the call returns is the
 * value too (`configured()` is the `makeLocationNode({...})` it returns). */
const absorbDefinitions = (graph: LayerGraph, parameters: boolean, generic: ReadonlySet<string>): LayerGraph => {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const usesOf = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) if (edge.kind === "uses") usesOf.set(edge.to, [...(usesOf.get(edge.to) ?? []), edge]);
  const feedsOnly = (id: string, into: (to: GraphNode | undefined) => boolean): boolean =>
    graph.edges.every((edge) => edge.from !== id || into(byId.get(edge.to)));
  // What a call's body returns, when that is all the body gives the call.
  const returned = (call: GraphNode): GraphNode | undefined => {
    const uses = usesOf.get(call.id) ?? [];
    const result = uses.length === 1 ? byId.get(uses[0]!.from) : undefined;
    return result && call.span && result.id.endsWith(`@${call.location.file}:${call.span.start}`)
      && feedsOnly(result.id, (to) => to?.id === call.id) ? result : undefined;
  };
  const absorbed = new Map<string, string>();
  const absorbers = new Set<string>();
  // A name that absorbs the call defining it keeps that call as written (`ports` is `apiPorts(clients, schemaApply, env)`).
  const written = new Map<string, string>();
  // A parameter is what its call passed (`tracerLayer` is the `relayTraceLayer` handed to it): the
  // argument takes its place, with its own facts, rather than the parameter's generic type.
  if (parameters) for (const node of graph.nodes) {
    if (node.reference !== "parameter") continue;
    const uses = usesOf.get(node.id) ?? [];
    const argument = uses.length === 1 ? byId.get(uses[0]!.from) : undefined;
    if (argument && argument.kind !== "root" && !absorbed.has(argument.id)) absorbed.set(node.id, argument.id);
  }
  for (const node of graph.nodes) {
    if (!isReference(node) || absorbed.has(node.id)) continue;
    const uses = usesOf.get(node.id) ?? [];
    const definition = uses.length === 1 ? byId.get(uses[0]!.from) : undefined;
    // Only an initializer that is nothing but this name's value: one the program also runs on its own
    // (a Worker's `const db = yield* Drizzle.Postgres(…)`, a boot action) keeps its place.
    const onlyThis = definition !== undefined && feedsOnly(definition.id, (to) => to?.label === node.label && isReference(to));
    if (definition && onlyThis && !isReference(definition) && definition.kind !== "root" && !absorbed.has(definition.id)
      && !absorbers.has(definition.id)) {
      absorbed.set(definition.id, node.id);
      absorbers.add(node.id);
      if (definition.calls !== undefined && definition.label !== node.label) written.set(node.id, definition.label.replace(/\s+/g, " ").trim());
      // A name's value made by a call (`node = configured()`) is what that call returns: `makeLocationNode({...})`.
      for (let call = returned(definition); call && !absorbed.has(call.id); call = returned(call)) absorbed.set(call.id, node.id);
    }
    // An input written with the name itself (`Location.node` under `Location.node`) is that name.
    for (const edge of uses) {
      const same = byId.get(edge.from);
      if (same && same.id !== node.id && same.label === node.label && !absorbed.has(same.id) && !absorbed.has(node.id)
        && !absorbers.has(same.id)) { absorbed.set(same.id, node.id); absorbers.add(node.id); }
    }
  }
  if (absorbed.size === 0) return graph;
  const through = (id: string): string => {
    for (let hops = 0, next = absorbed.get(id); next !== undefined && hops < 64; hops++, next = absorbed.get(id)) id = next;
    return id;
  };
  // What is absorbed keeps its lifetime (`makeGlobalNode` is global) on what absorbs it.
  const scopes = new Map<string, GraphNode["scope"]>();
  for (const id of absorbed.keys()) {
    const scope = byId.get(id)?.scope;
    if (scope === "global" || scope === "location") scopes.set(through(id), scope);
  }
  const seen = new Set<string>();
  return {
    nodes: graph.nodes.filter((node) => !absorbed.has(node.id)).map((node) => {
      const scope = scopes.get(node.id), call = written.get(node.id);
      return scope && node.scope !== scope || call !== undefined
        ? { ...node, ...(scope && node.scope !== scope ? { scope } : {}), ...(call !== undefined ? { written: call } : {}) } : node;
    }),
    edges: graph.edges.map((edge) => ({ ...edge, from: through(edge.from), to: through(edge.to),
      ...(generic.has(edge.from) && absorbed.has(edge.from) && byId.get(edge.from)?.reference === "parameter"
        ? { parameter: { id: edge.from, name: byId.get(edge.from)!.label, location: byId.get(edge.from)!.location } } : {}) }))
      .filter((edge) => {
      const key = `${edge.from}\0${edge.to}\0${edge.kind}`;
      if (edge.from === edge.to || seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
};

/** `parameters`: also let each bound parameter become its argument. Only once the compiler's
 * composition is merged, which places its own nodes at the parameter's span. */
export const foldCallContexts = <T extends { readonly graph: LayerGraph }>(
  named: T, options: { readonly parameters?: boolean; /** Parameters whose type is generic. */ readonly generic?: ReadonlySet<string> } = {},
): T => {
  const { nodes, edges } = absorbDefinitions(named.graph, options.parameters ?? false, options.generic ?? new Set());
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // A name the application gives (`Bus.node`, `ServerConfig.layer`) stands for its
  // declaration, wherever it is written: references with the same inputs are one
  // Layer. An anonymous expression is its own Layer at each place it is written.
  // A reference's source text is its label; a call (labelled by its callee) spans its arguments too,
  // and two calls are two Layers.
  const isName = isReference;
  const inputCount = new Map<string, number>();
  for (const edge of edges) inputCount.set(edge.to, (inputCount.get(edge.to) ?? 0) + 1);
  // A reference is its declaration. With inputs (its absorbed definition, its deps) those identify the
  // declaration, being keyed by their own place; a bare reference is only known to be the same where it is written.
  const spanKey = (node: GraphNode): string | undefined =>
    isName(node) && node.declaration ? `declaration:${node.declaration}`
    : isName(node) ? (inputCount.get(node.id) ? `name:${node.label}` : `${node.location.file}:name:${node.label}`)
      : node.span ? `${node.location.file}:${node.span.start}:${node.span.end}` : undefined;
  const spans = new Map<string, number>();
  for (const node of nodes) { const key = spanKey(node); if (key) spans.set(key, (spans.get(key) ?? 0) + 1); }
  const unfolded = { ...named, graph: { ...named.graph, nodes, edges } };
  if (![...spans.values()].some((count) => count > 1)) return unfolded;
  const inputs = new Map<string, GraphEdge[]>();
  for (const edge of edges) inputs.set(edge.to, [...(inputs.get(edge.to) ?? []), edge]);

  // A node's structure, independent of the call context in its id. Each distinct
  // structure is interned as `#n`, so a parent names its inputs without copying them.
  const signatures = new Map<string, string>();
  const structures = new Map<string, string>();
  const active = new Set<string>();
  const signature = (id: string): string => {
    const cached = signatures.get(id);
    if (cached !== undefined) return cached;
    if (active.has(id)) return `cycle:${spanKey(byId.get(id)!) ?? id}`;
    active.add(id);
    const node = byId.get(id)!;
    const below = (inputs.get(id) ?? []).map((edge) => `${edge.kind}:${signature(edge.from)}`).sort();
    active.delete(id);
    const structure = `${node.kind}|${node.label}|${spanKey(node) ?? id}|${node.scope ?? ""}|${node.bound ?? ""}|[${below.join(",")}]`;
    let value = structures.get(structure);
    if (value === undefined) { value = `#${structures.size}`; structures.set(structure, value); }
    signatures.set(id, value);
    return value;
  };
  const canonical = new Map<string, string>();
  const alias = new Map<string, string>();
  // A declared name is one value wherever it is written, however each place was expanded:
  // its copies are one node, with the inputs of all of them.
  const declared = new Map<string, string>();
  const gathered = new Set<string>();
  for (const node of [...nodes].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id))) {
    if (!isName(node) || !node.declaration) continue;
    const key = `${node.declaration}\0${node.kind}`;
    const kept = declared.get(key);
    if (kept === undefined) declared.set(key, node.id);
    else { alias.set(node.id, kept); gathered.add(kept); }
  }
  // The copy with the shortest context stands for the others.
  for (const node of [...nodes].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id))) {
    if (alias.has(node.id)) continue;
    const key = spanKey(node);
    if (!key || (spans.get(key) ?? 0) < 2) continue;
    const structure = signature(node.id);
    const kept = canonical.get(structure);
    if (kept === undefined) canonical.set(structure, node.id);
    else alias.set(node.id, kept);
  }
  if (alias.size === 0) return unfolded;
  // A name that stands for every place it is written is found at its declaration.
  const declaredAt = (node: GraphNode): GraphNode => {
    if (!gathered.has(node.id) || !node.declaration) return node;
    const place = /^(.*):(\d+):(\d+)$/.exec(node.declaration);
    return place ? { ...node, location: { file: place[1]!, line: Number(place[2]), column: Number(place[3]) } } : node;
  };
  const resolve = (id: string): string => alias.get(id) ?? id;
  const seen = new Set<string>();
  const folded = edges.map((edge) => ({ ...edge, from: resolve(edge.from), to: resolve(edge.to) })).filter((edge) => {
    const key = `${edge.from}\0${edge.to}\0${edge.kind}`;
    if (edge.from === edge.to || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...named, graph: { ...named.graph, nodes: nodes.filter((node) => !alias.has(node.id)).map(declaredAt), edges: folded } };
};
