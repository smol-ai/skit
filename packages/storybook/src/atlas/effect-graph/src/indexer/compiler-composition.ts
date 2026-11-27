import type { GraphEdge, GraphNode, LayerGraph } from "./graph-artifact.ts";
import type { LayerTypeFacts } from "./layer-type-facts.ts";

interface Named {
  readonly name: string;
  readonly entryFile?: string;
  readonly graph: LayerGraph;
}
type Fact = LayerTypeFacts["facts"][number];
type Composition = NonNullable<LayerTypeFacts["composition"]>;
type CompositionNode = Composition["nodes"][number];

/**
 * Each entry's graph with the compiler's Layer composition in place of the
 * walker's. Wherever the compiler expands a Layer it understands (a pipe, a
 * call of Effect's own `Layer` combinators, an array, a name's declaration),
 * its parts replace the walker's inputs to that Layer. Everywhere else the
 * walker's inputs stay: a call of the application's own function, whose body
 * the compiler does not enter; a helper's parameter bound at the call; or
 * `Layer.unwrap(Effect.gen(...))`, whose Layers the compiler does not follow.
 *
 * Under a composite the compiler expands, only the walker inputs written inside
 * a part it accounts for are replaced; one it does not account for, such as
 * the body of a `Layer.flatMap`, stays.
 *
 * A composition node reuses the walker node at the same file, span and call
 * context, so facts and bindings carry over; otherwise it is added. Every
 * reference to a declared Layer is one node, labelled by the most qualified
 * name it is referenced with. New nodes get facts from the composition.
 */
export const withCompilerComposition = <T extends Named>(
  graphs: ReadonlyArray<T>, types: LayerTypeFacts,
): { readonly graphs: ReadonlyArray<T>; readonly facts: ReadonlyArray<Fact> } => {
  const composition = types.composition;
  if (!composition) return { graphs, facts: [] };
  // Compiler labels are the expression's text; clip them as the walker clips its own.
  const clip = (label: string): string => {
    const line = label.replace(/\s+/g, " ").trim();
    return line.length <= 120 ? line : `${line.slice(0, 119)}…`;
  };
  const compNodes = new Map(composition.nodes.map((node) => [node.id, { ...node, label: clip(node.label) }]));
  // A call renamed to the name it is declared as keeps the call as written: `ports` is `apiPorts(clients, schemaApply, env)`.
  const callWritten = (node: GraphNode, label: string): { readonly written?: string } =>
    node.calls !== undefined && node.written === undefined && node.label !== label ? { written: node.label } : {};
  const parts = new Map<string, Array<Composition["edges"][number]>>();
  for (const edge of composition.edges) parts.set(edge.from, [...(parts.get(edge.from) ?? []), edge]);
  const anchors = new Map(composition.anchors.map((anchor) => [anchor.nodeId, anchor.composition]));
  const extraFacts = new Map<string, Fact>();

  // A name's parts are its initializer's: follow `symbol` edges through.
  const expanded = (id: string, seen = new Set<string>()): ReadonlyArray<Composition["edges"][number]> => {
    const edges = parts.get(id) ?? [];
    const symbol = edges.find((edge) => edge.relationship === "symbol");
    if (!symbol || seen.has(symbol.to)) return edges.filter((edge) => edge.relationship !== "symbol");
    seen.add(id);
    return expanded(symbol.to, seen);
  };

  // The expression a name stands for: its initializer, through `symbol` edges.
  const followed = (id: string, seen = new Set<string>()): string => {
    const symbol = (parts.get(id) ?? []).find((edge) => edge.relationship === "symbol");
    if (!symbol || seen.has(symbol.to)) return id;
    seen.add(id);
    return followed(symbol.to, seen);
  };
  // Array elements stand where the array is written, as in `Layer.mergeAll([a, b])`.
  const flatten = (id: string): ReadonlyArray<string> => {
    const node = compNodes.get(id);
    const elements = expanded(id).filter((edge) => edge.relationship === "arrayLiteral");
    return node && elements.length > 0 ? elements.flatMap((edge) => flatten(edge.to)) : [id];
  };
  /** A composite's inputs as the source reads them: a pipe's base and what
   * each step provides or merges; a merge's members; a data-first provide's
   * self and what it provides. The compiler decides which inputs exist; the
   * resolved `Layer` member (a closed set) names how each one joins. */
  const shaped = (named: string): ReadonlyArray<{ readonly part: string; readonly kind: GraphEdge["kind"] }> => {
    const id = followed(named);
    const edges = expanded(id);
    const calls = (of: string) => expanded(of).filter((edge) => edge.relationship === "call")
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const joining = (combinator: string | undefined): GraphEdge["kind"] =>
      combinator === "provide" ? "provide" : combinator === "provideMerge" ? "provideMerge"
      : combinator === "merge" || combinator === "mergeAll" ? "merge" : "uses";
    const pipe = edges.find((edge) => edge.relationship === "pipe");
    if (pipe) {
      // Upstream links a pipe to its last step and each step to the one before.
      const steps: string[] = [];
      for (let step: string | undefined = pipe.to; step !== undefined && !steps.includes(step);) {
        steps.unshift(step);
        // A step's own pipe edge, not its declaration's: a base that is a name ends the chain.
        step = (parts.get(step) ?? []).find((edge) => edge.relationship === "pipe")?.to;
      }
      const [base, ...operations] = steps;
      return [
        ...(base === undefined ? [] : [{ part: base, kind: "uses" as const }]),
        ...operations.flatMap((operation) => calls(operation).flatMap((edge) =>
          flatten(edge.to).map((part) => ({ part, kind: joining(compNodes.get(operation)?.combinator) })))),
      ];
    }
    // These links retain their meaning: a factory body is uninstantiated,
    // returned sites are alternatives, and runtime points to an existing context.
    const supplemental = edges.filter((edge) => edge.relationship === "factory"
      || edge.relationship === "returned" || edge.relationship === "runtime")
      .map((edge) => ({ part: edge.to, kind: edge.relationship as GraphEdge["kind"] }));
    const combinator = compNodes.get(id)?.combinator;
    const args = calls(id);
    // A call of the application's own function (`withStdio(x)`) composes more
    // than its Layer arguments: the walker's expansion of its body stays.
    if (args.length > 0 && combinator === undefined) return supplemental;
    if (args.length > 0) {
      if ((combinator === "provide" || combinator === "provideMerge") && args.length === 2)
        return [{ part: args[0]!.to, kind: "uses" }, ...flatten(args[1]!.to).map((part) => ({ part, kind: joining(combinator) }))];
      return [...supplemental, ...args.flatMap((edge) => flatten(edge.to).map((part) => ({ part, kind: joining(combinator) })))];
    }
    return [...supplemental, ...edges.filter((edge) => edge.relationship === "arrayLiteral").flatMap((edge) => flatten(edge.to))
      .map((part) => ({ part, kind: "merge" as const }))];
  };

  // A declaration is read by the name it is referenced with: `AnalyticsService.layer`
  // names what the module declares as `layer`.
  const declaredLabel = new Map<string, string>();
  // Otherwise by the name the application imports it as (`layerConfig` imported as
  // SqlitePersistenceLayerLive), and only then by its own name.
  const importedAs = new Map<string, string>();
  for (const node of composition.nodes) {
    const declaration = followed(node.id);
    if (declaration === node.id || node.name === undefined) continue;
    const own = compNodes.get(declaration)!.label;
    const current = declaredLabel.get(declaration) ?? own;
    if ((node.name === own || node.name.endsWith(`.${own}`)) && node.name.length > current.length) declaredLabel.set(declaration, node.name);
    else if (!node.name.includes(".") && node.name !== own && !importedAs.has(declaration)) importedAs.set(declaration, node.name);
  }
  for (const [declaration, name] of importedAs) if (!declaredLabel.has(declaration)) declaredLabel.set(declaration, name);

  // Initializers some name is followed to.
  const declarations = new Set(composition.nodes.map((node) => followed(node.id)).filter((id, index) => id !== composition.nodes[index]!.id));
  const moduleLevel = new Set(composition.nodes.filter((node) => !node.local)
    .map((node) => `${node.file}:${node.span.start}:${node.span.end}`));

  const merged = graphs.map((named) => {
    const nodes = new Map(named.graph.nodes.map((node) => [node.id, node]));
    const context = (id: string): string => /@.*$/.exec(id)?.[0] ?? "";
    const spanKey = (file: string, start: number, end: number, ctx: string) => `${file}:${start}:${end}${ctx}`;
    const bySpan = new Map<string, string>();
    for (const node of named.graph.nodes) if (node.span)
      bySpan.set(spanKey(node.location.file, node.span.start, node.span.end, context(node.id)), node.id);
    // A declaration is module level: any call context the walker expanded it in is the same Layer.
    const anySpan = new Map<string, string>();
    for (const node of [...named.graph.nodes].sort((a, b) => context(a.id).length - context(b.id).length)) if (node.span) {
      const key = spanKey(node.location.file, node.span.start, node.span.end, "");
      if (!anySpan.has(key)) anySpan.set(key, node.id);
    }
    type Region = { readonly file: string; readonly start: number; readonly end: number };
    // For each composite the compiler expands, the source it accounts for.
    const understood = new Map<string, Region[]>();
    // Walker nodes that are a reference to a declaration, and that declaration's node.
    const alias = new Map<string, string>();
    const resolve = (id: string): string => {
      for (let hops = 0; alias.has(id) && hops < 64; hops++) id = alias.get(id)!;
      return id;
    };
    const added: GraphEdge[] = [];

    const add = (id: string, comp: CompositionNode, label = comp.label, reference = comp.reference): string => {
      if (!nodes.has(id)) {
        nodes.set(id, {
          id, kind: "layer", ...(comp.layer ? { role: "layer" as const } : {}), label, ...(comp.origin ? { origin: comp.origin } : {}),
          location: { file: comp.file, line: comp.line, column: comp.column },
          span: comp.span, ...(reference ? { reference } : {}),
        });
        if (comp.layer) extraFacts.set(id, { nodeId: id, status: "resolved", role: "layer", provides: comp.provides, errors: [], requires: comp.requires });
      }
      return id;
    };
    // Every reference to a declared Layer is that one Layer: Effect memoizes a
    // Layer by reference. The walker's node for the initializer, when there is
    // one, keeps what the compiler does not expand beneath it.
    const declarationNode = (declaration: string): string => {
      const declared = compNodes.get(declaration)!;
      const label = declaredLabel.get(declaration) ?? declared.label;
      const walked = anySpan.get(spanKey(declared.file, declared.span.start, declared.span.end, ""));
      if (!walked) return add(`composition:${declaration}`, declared, label, "module");
      const node = nodes.get(walked)!;
      if (node.label !== label || declared.origin !== node.origin) {
        const updated = { ...node, label, reference: "module" as const, ...callWritten(node, label) };
        if (declared.origin === undefined) delete updated.origin;
        else updated.origin = declared.origin;
        nodes.set(walked, updated);
      }
      return walked;
    };
    // The walker names a call of Effect's own constructors by its callee
    // (`Layer.effect`); a leaf reads better as what it constructs.
    // The compiler's resolution of who declares it fills in a reference the walker did not record.
    // The compiler also settles whether it is a Layer: the walker marks what it reached as an Effect.
    const relabelLeaf = (id: string, comp: CompositionNode): string => {
      const node = nodes.get(id)!;
      const label = shaped(comp.id).length === 0 && comp.label.startsWith(`${node.label}(`) ? comp.label : node.label;
      const reference = node.reference ?? comp.reference;
      const kind = comp.layer && node.kind === "effect" ? "layer" : node.kind;
      if (label !== node.label || reference !== node.reference || kind !== node.kind || comp.origin !== node.origin) {
        const updated = { ...node, label, kind, ...(reference ? { reference } : {}) };
        if (comp.origin === undefined) delete updated.origin;
        else updated.origin = comp.origin;
        nodes.set(id, updated);
      }
      return id;
    };
    // A library's Layer is one node however many places name it.
    const libraryNodes = new Map<string, string>();
    const libraryNode = (comp: CompositionNode): string => {
      const existing = libraryNodes.get(comp.library!);
      if (existing) return existing;
      // Named as the library names it where it is written (`NodeServices.layer`), never by an
      // application alias of it such as `PlatformServicesLive`.
      const label = comp.name ?? comp.label;
      const walked = anySpan.get(spanKey(comp.file, comp.span.start, comp.span.end, ""));
      const id = walked ?? add(`library:${comp.library}`, comp, label);
      if (walked && nodes.get(walked)!.label !== label) nodes.set(walked, { ...nodes.get(walked)!, label });
      libraryNodes.set(comp.library!, id);
      return id;
    };
    const place = (comp: CompositionNode, ctx: string): string => {
      const declaration = followed(comp.id);
      const declared = compNodes.get(declaration)!;
      if (declared.library) return libraryNode(declared);
      if (declaration !== comp.id) return declarationNode(declaration);
      if (!comp.local) {
        const walked = anySpan.get(spanKey(comp.file, comp.span.start, comp.span.end, ""));
        return walked === undefined ? add(`composition:${comp.id}`, comp) : relabelLeaf(walked, comp);
      }
      const walked = bySpan.get(spanKey(comp.file, comp.span.start, comp.span.end, ctx));
      return walked === undefined ? add(`composition:${comp.id}${ctx}`, comp) : relabelLeaf(resolve(walked), comp);
    };

    const visit = (reached: string, graphId: string, ctx: string, seen: Set<string>): void => {
      // A reference is its declaration: expand the declaration, on its one node.
      const compId = followed(reached);
      if (compId !== reached) {
        const declared = declarationNode(compId);
        if (declared !== graphId) {
          alias.set(graphId, declared);
          visit(compId, declared, context(declared), seen);
          return;
        }
      }
      if (seen.has(graphId)) return;
      seen.add(graphId);
      const inputs = shaped(compId);
      if (inputs.length === 0) return;
      const regions = understood.get(graphId) ?? [];
      understood.set(graphId, regions);
      for (const { part: partCompId, kind } of inputs) {
        const part = compNodes.get(partCompId);
        if (!part) continue;
        // Supplemental links add evidence; they do not replace the walker's
        // expansion, even where their definition spans contain walker inputs.
        const replacesWalker = !["factory", "returned", "runtime"].includes(kind);
        for (let at: string | undefined = replacesWalker ? part.id : undefined, hops = 0; at !== undefined && hops < 16; hops++) {
          const node = compNodes.get(at)!;
          regions.push({ file: node.file, start: node.span.start, end: node.span.end });
          const next: string | undefined = (parts.get(at) ?? []).find((edge) => edge.relationship === "symbol")?.to;
          at = next === at ? undefined : next;
        }
        const partId = place(part, ctx);
        // The edge is where the part is written in the composite, not where it is declared.
        added.push({ from: partId, to: graphId, kind, location: { file: part.file, line: part.line, column: part.column } });
        visit(part.id, partId, ctx, seen);
      }
    };
    // A module-level expression is one expression, whatever call the walker
    // reached it through: its copies in other contexts are the same node.
    for (const node of named.graph.nodes) if (node.span) {
      const key = spanKey(node.location.file, node.span.start, node.span.end, "");
      const canonical = anySpan.get(key);
      if (moduleLevel.has(key) && canonical !== undefined && canonical !== node.id) alias.set(node.id, canonical);
    }
    for (const node of named.graph.nodes) {
      const compId = anchors.get(node.id);
      if (!compId) continue;
      // A library Layer the walker reached is the one node for its declaration.
      const library = compNodes.get(followed(compId))!;
      if (library.library) {
        const one = libraryNode(library);
        if (one !== resolve(node.id)) alias.set(resolve(node.id), one);
        continue;
      }
      // An anchor that is a declaration's initializer reads as the declared name.
      if (declarations.has(compId)) {
        const id = resolve(node.id);
        const label = declaredLabel.get(compId) ?? compNodes.get(compId)!.label;
        const current = nodes.get(id)!;
        if (current.label !== label) nodes.set(id, { ...current, label, reference: current.reference ?? "module", ...callWritten(current, label) });
      }
      if (followed(compId) === compId) relabelLeaf(resolve(node.id), compNodes.get(compId)!);
      visit(compId, resolve(node.id), context(resolve(node.id)), new Set());
    }
    // The compiler's parts replace the walker's inputs written inside them; an
    // input the compiler did not account for (the body of a `Layer.flatMap`)
    // stays. A declared service's type edges describe the Layer and stay.
    const accounted = (edge: GraphEdge): boolean => {
      const regions = understood.get(resolve(edge.to));
      const from = nodes.get(edge.from);
      if (!regions || !from?.span || edge.kind === "provides" || edge.kind === "requires") return false;
      return regions.some((region) => region.file === from.location.file
        && from.span!.start >= region.start && from.span!.end <= region.end);
    };
    const resolveAll = resolve;
    const keys = new Set<string>();
    let edges = [...named.graph.edges.filter((edge) => !accounted(edge)), ...added]
      .map((edge) => ({ ...edge, from: resolve(edge.from), to: resolve(edge.to) }))
      .filter((edge) => {
        const key = `${edge.from}\0${edge.to}\0${edge.kind}`;
        if (edge.from === edge.to || keys.has(key)) return false;
        keys.add(key);
        return true;
      });
    // Siblings that are one source expression, expanded by the walker in
    // different call contexts, are one node once their parent is one Layer.
    for (let changed = true; changed;) {
      changed = false;
      const inputs = new Map<string, GraphEdge[]>();
      for (const edge of edges) inputs.set(edge.to, [...(inputs.get(edge.to) ?? []), edge]);
      for (const [consumer, siblings] of inputs) {
        const into = nodes.get(consumer);
        const first = new Map<string, string>();
        // An input written at the consumer's own span is the consumer, reached in another context.
        if (into?.span) first.set(spanKey(into.location.file, into.span.start, into.span.end, ""), consumer);
        for (const edge of siblings) {
          const node = nodes.get(edge.from);
          if (!node?.span || alias.has(edge.from)) continue;
          const key = spanKey(node.location.file, node.span.start, node.span.end, "");
          const kept = first.get(key);
          if (kept === undefined) first.set(key, edge.from);
          else if (kept !== edge.from) { alias.set(edge.from, kept); changed = true; }
        }
      }
      if (changed) {
        const merge = new Set<string>();
        edges = edges.map((edge) => ({ ...edge, from: resolveAll(edge.from), to: resolveAll(edge.to) })).filter((edge) => {
          const key = `${edge.from}\0${edge.to}\0${edge.kind}`;
          if (edge.from === edge.to || merge.has(key)) return false;
          merge.add(key);
          return true;
        });
      }
    }
    // A reference whose only input is the definition of the same name is that
    // definition: a name the walker followed, or a parameter bound at the call.
    for (let changed = true; changed;) {
      changed = false;
      const into = new Map<string, GraphEdge[]>();
      for (const edge of edges) into.set(edge.to, [...(into.get(edge.to) ?? []), edge]);
      for (const [consumer, inputs] of into) {
        const reference = nodes.get(consumer);
        const only = inputs.length === 1 && inputs[0]!.kind === "uses" ? nodes.get(inputs[0]!.from) : undefined;
        if (!reference || !only || alias.has(consumer) || reference.kind === "root" || only.label !== reference.label
          || only.kind !== reference.kind) continue;
        alias.set(consumer, only.id);
        changed = true;
      }
      if (changed) {
        const merge = new Set<string>();
        edges = edges.map((edge) => ({ ...edge, from: resolveAll(edge.from), to: resolveAll(edge.to) })).filter((edge) => {
          const key = `${edge.from}\0${edge.to}\0${edge.kind}`;
          if (edge.from === edge.to || merge.has(key)) return false;
          merge.add(key);
          return true;
        });
      }
    }
    for (const id of alias.keys()) nodes.delete(id);
    // Walker nodes only the replaced inputs reached are no longer part of the entry.
    const reach = (graphEdges: ReadonlyArray<GraphEdge>): Set<string> => {
      const into = new Map<string, string[]>();
      for (const edge of graphEdges) into.set(edge.to, [...(into.get(edge.to) ?? []), edge.from]);
      const set = new Set<string>();
      for (const stack = named.graph.nodes.filter((node) => node.kind === "root").map((node) => node.id); stack.length > 0;) {
        const id = stack.pop()!;
        if (set.has(id)) continue;
        set.add(id);
        stack.push(...(into.get(id) ?? []));
      }
      return set;
    };
    const reachable = reach(edges);
    const reachableBefore = reach(named.graph.edges);
    const kept = [...nodes.values()].filter((node) => reachable.has(node.id)
      || !reachableBefore.has(node.id) && !node.id.startsWith("composition:"));
    const keptIds = new Set(kept.map((node) => node.id));
    edges = edges.filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to));
    return { ...named, graph: { ...named.graph, nodes: kept, edges } };
  });
  const kept = new Set(merged.flatMap((named) => named.graph.nodes.map((node) => node.id)));
  return { graphs: merged, facts: [...extraFacts.values()].filter((fact) => kept.has(fact.nodeId)) };
};
