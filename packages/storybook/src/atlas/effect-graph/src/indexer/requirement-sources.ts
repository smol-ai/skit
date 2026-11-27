import type { GraphEdge, GraphNode, LayerGraph } from "./graph-artifact.ts";

/** The compiler facts this needs, keyed by type ID rather than display name. */
export interface RequirementFact {
  readonly status: "resolved" | "partial" | "unresolved";
  /** An Effect whose value is a Layer: its requirements are not that Layer's. */
  readonly producesLayer?: boolean | undefined;
  /** An Effect whose value is an Effect: what the inner one requires, moved there rather than met. */
  readonly innerRequires?: ReadonlyArray<string> | undefined;
  readonly provides: ReadonlyArray<string>;
  readonly requires: ReadonlyArray<string>;
  readonly role?: "layer" | "program" | "carrier" | "callback" | undefined;
}

/** Where one requirement of a part is met, on the part's own paths to the
 * composition's entry points. Each path ends in exactly one of these:
 * - `providers`: the Layers provided into the path whose compiler type
 *   provides the service, traced to the Layer inside them it comes from;
 * - `satisfiedAt`: the nearest expression on the path whose compiler type no
 *   longer requires it, when nothing is provided there as a Layer (a runtime,
 *   `HttpRouter.serve`, a function that builds the router internally);
 * - `openAt`: where a path ended with neither. At a root, the requirement is
 *   left to that entry point (a Worker's runtime supplies the event's
 *   request and environment); anywhere else the graph lost the path. */
export interface RequirementSources {
  readonly providers: ReadonlyArray<RequirementProvider>;
  readonly satisfiedAt: ReadonlyArray<GraphNode>;
  /** Where the trail ends because the requirement passed through something whose type is
   * generic and does not name it: the parameter (`routes`) when one is known. */
  readonly untrackedAt: ReadonlyArray<GraphNode>;
  readonly openAt: ReadonlyArray<GraphNode>;
}

/** A Layer that supplies the service: `origin` is the innermost expression
 * whose type provides it, `through` the Layer provided into the part's path
 * that carries it there (the same node when nothing wraps it). */
interface RequirementProvider {
  readonly origin: GraphNode;
  readonly through: GraphNode;
  /** The Layer `origin` stands in for, when a `.replace(...)` in this entry replaces it. */
  readonly replacing?: GraphNode;
}

const PROVIDING = new Set<GraphEdge["kind"]>(["provide", "provideMerge"]);
/** `provides`/`requires` edges run from a declared service type to its Layer;
 * they describe a type, not a place the Layer is composed into. */
const TYPE_ONLY = new Set<GraphEdge["kind"]>(["provides", "requires"]);
/** Inputs whose outputs a Layer passes on: a merge, a provideMerge, the Layer a
 * name or pipe is built from. A `provide` input is consumed, not passed on. */
const PASSING = new Set<GraphEdge["kind"]>(["merge", "provideMerge", "uses", "unwrap", "pipe", "call", "arrayLiteral", "fallback", "runtime"]);
/** Inputs that make up an expression, as either the walker or the compiler joins them. */
const COMPOSED = new Set<GraphEdge["kind"]>([...PASSING, "provide", "launch"]);

interface GraphIndex {
  readonly byId: ReadonlyMap<string, GraphNode>;
  readonly incoming: ReadonlyMap<string, ReadonlyArray<GraphEdge>>;
  readonly outgoing: ReadonlyMap<string, ReadonlyArray<GraphEdge>>;
}

/** A page asks for every requirement of every part of one graph. */
const indexes = new WeakMap<LayerGraph, GraphIndex>();
const indexOf = (graph: LayerGraph): GraphIndex => {
  const cached = indexes.get(graph);
  if (cached) return cached;
  const incoming = new Map<string, GraphEdge[]>();
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (TYPE_ONLY.has(edge.kind)) continue;
    const into = incoming.get(edge.to);
    if (into) into.push(edge); else incoming.set(edge.to, [edge]);
    const from = outgoing.get(edge.from);
    if (from) from.push(edge); else outgoing.set(edge.from, [edge]);
  }
  const index = { byId: new Map(graph.nodes.map((node) => [node.id, node])), incoming, outgoing };
  indexes.set(graph, index);
  return index;
};

/** Follow a part toward the composition's entry points and stop each path at
 * the first place the requirement is met. Never looks outside `graph`. */
export const requirementSources = (
  graph: LayerGraph, facts: ReadonlyMap<string, RequirementFact>, nodeId: string, typeId: string,
  /** Other type ids for the same service: a plain X supplies `Request<"Requires", X>`. */
  equivalent: ReadonlyArray<string> = [],
): RequirementSources => {
  const { byId, incoming, outgoing } = indexOf(graph);
  // A handler's environment belongs to event execution. The Effect that creates
  // the handler has a different contract; disappearance from that outer R is
  // not discharge. Explicit Layers provided along the path still count.
  const creationOnly = new Set<string>();
  if (byId.get(nodeId)?.scope === "invocation") {
    const ancestors = new Set<string>();
    for (const queue = [nodeId]; queue.length > 0;) {
      const id = queue.shift()!;
      if (ancestors.has(id)) continue;
      ancestors.add(id);
      if (byId.get(id)?.scope === "isolate") creationOnly.add(id);
      queue.push(...(outgoing.get(id) ?? []).map((edge) => edge.to));
    }
    for (const queue = [...creationOnly]; queue.length > 0;) {
      for (const edge of outgoing.get(queue.shift()!) ?? []) if (!creationOnly.has(edge.to)) {
        creationOnly.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  // A partial fact still names the concrete services it provides; only its
  // unresolved members (a type parameter, an error type) are in doubt.
  const suppliesIt = (id: string): boolean => {
    const fact = facts.get(id);
    return fact?.role !== "callback" && fact?.role !== "carrier" && (fact?.status === "resolved" || fact?.status === "partial")
      && (fact.provides.includes(typeId) || equivalent.some((id) => fact.provides.includes(id)));
  };
  // `effect` references are Effect's own constructors (`Layer.effect`), not names the source gives.
  const named = (node: GraphNode): boolean => node.reference !== undefined && node.reference !== "effect";
  // Descend through the Layers that pass the service on to the ones it comes
  // from, each once. A leaf is reported by its name, or, when it is anonymous
  // (a `Layer.effect(...)` inside a declaration), by the nearest named Layer
  // on the way down to it. A composite reached twice is not a second origin.
  const origins = (id: string): ReadonlyArray<string> => {
    const found = new Set<string>();
    const visited = new Set<string>();
    const descend = (current: string, nearestNamed: string | undefined): void => {
      if (visited.has(current)) return;
      visited.add(current);
      const node = byId.get(current)!;
      const namedHere = named(node) && !node.origin ? current : nearestNamed;
      const inputs = (incoming.get(current) ?? []).filter((edge) => PASSING.has(edge.kind) && suppliesIt(edge.from));
      // A captured service is re-exposed, not constructed here. Runtime
      // context bridges likewise need an actual origin beneath them.
      if (inputs.length === 0 && !node.origin) found.add(named(node) ? current : nearestNamed ?? current);
      for (const edge of inputs) descend(edge.from, namedHere);
    };
    descend(id, undefined);
    return [...found];
  };
  // `original.replace(replacement)`: in this entry the replacement supplies what the original would.
  const replacements = new Map<string, string>();
  for (const [consumer, into] of incoming) {
    const replacement = into.find((edge) => edge.kind === "replaces");
    const original = into.find((edge) => edge.kind === "uses");
    if (replacement && original && byId.get(consumer)) replacements.set(original.from, replacement.from);
  }
  const provider = (origin: string, through: string): [string, RequirementProvider] => {
    const replacement = replacements.get(origin);
    return replacement
      ? [`${replacement}\0${through}`, { origin: byId.get(replacement)!, through: byId.get(through)!, replacing: byId.get(origin)! }]
      : [`${origin}\0${through}`, { origin: byId.get(origin)!, through: byId.get(through)! }];
  };
  const providers = new Map<string, RequirementProvider>();
  const satisfiedAt = new Map<string, GraphNode>();
  const openAt = new Map<string, GraphNode>();
  const untrackedAt = new Map<string, GraphNode>();
  // The node each one was reached from.
  const from = new Map<string, string>();
  // The generic parameter a node was reached through, whose type may not name the service.
  const arrivedThrough = new Map<string, NonNullable<GraphEdge["parameter"]>>();
  const erased = (parameter: string | undefined): boolean => {
    const fact = parameter === undefined ? undefined : facts.get(parameter);
    return fact?.status === "partial" && !fact.requires.includes(typeId) && !equivalent.some((id) => fact.requires.includes(id));
  };
  const seen = new Set([nodeId]);
  // An Effect a Layer is returned from (`Layer.unwrap(Effect.gen(... return layer))`) produces that
  // Layer: its own requirements are not the Layer's, so it cannot be where the Layer's are met.
  const producers = new Set<string>();
  for (const queue = [nodeId]; queue.length > 0;) {
    const id = queue.shift()!;
    let provided = false;
    for (const edge of incoming.get(id) ?? []) {
      if (!PROVIDING.has(edge.kind) || edge.from === nodeId) continue;
      if (!suppliesIt(edge.from)) continue;
      const found = origins(edge.from);
      for (const origin of found) providers.set(...provider(origin, edge.from));
      if (found.length > 0) provided = true;
    }
    if (provided) continue;
    // A name bound to `yield* x` is x's result: x's requirements are met where x runs, not where the value goes.
    const fact = facts.get(id);
    if (id !== nodeId && byId.get(id)?.value === "yielded"
      && !fact?.requires.some((type) => type === typeId || equivalent.includes(type))
      && !fact?.innerRequires?.some((type) => type === typeId || equivalent.includes(type))) continue;
    // An Effect that produces an Effect (a router's per-request handler) passes that handler's requirements into it.
    const movedInward = fact?.innerRequires?.some((id) => id === typeId || equivalent.includes(id)) ?? false;
    if (id !== nodeId && !creationOnly.has(id) && !producers.has(id) && !movedInward && fact?.role !== "carrier" && fact?.role !== "callback" && fact?.status === "resolved" && !fact.requires.includes(typeId)) {
      // Met inside this expression: by an input whose type provides the
      // service, whatever combinator joins them (`Layer.provide(x)` in a pipe,
      // a call of Layers), or else by the expression itself.
      const suppliers = (incoming.get(id) ?? []).filter((edge) => COMPOSED.has(edge.kind) && suppliesIt(edge.from) && origins(edge.from).length > 0
        && !facts.get(edge.from)?.requires.includes(typeId));
      for (const edge of suppliers) for (const origin of origins(edge.from)) providers.set(...provider(origin, edge.from));
      // A per-request service that became the plain service here (`HttpRouter.serve` asks the
      // application for it) is still to be found further out; otherwise it was met here.
      const becamePlain = equivalent.some((plain) => fact.requires.includes(plain));
      if (suppliers.length > 0 || !becamePlain) {
        // Gone only because the input it came through is generic (`routes: Layer<A, E, Request<"Requires", unknown>>`):
        // the types stopped tracking it here, which is not the same as meeting it.
        if (suppliers.length === 0) {
          const parameter = arrivedThrough.get(id);
          const generic = parameter && erased(parameter.id)
            ? { id: parameter.id, kind: "layer" as const, label: parameter.name, location: parameter.location }
            : erased(from.get(id)) ? byId.get(from.get(id)!) : undefined;
          if (generic) untrackedAt.set(generic.id, generic);
          else satisfiedAt.set(id, byId.get(id)!);
        }
        continue;
      }
    }
    const outgoingEdges = outgoing.get(id) ?? [];
    // The caller's resolved contract can prove that a requirement continues.
    // Its disappearance alone cannot prove how factory arguments met it.
    const up = outgoingEdges.filter((edge) => {
      if (edge.kind !== "factory") return true;
      const caller = facts.get(edge.to);
      if (caller?.status === "resolved" && caller.requires.some((type) => type === typeId || equivalent.includes(type))) return true;
      untrackedAt.set(id, byId.get(id)!);
      return false;
    });
    if (outgoingEdges.length === 0) openAt.set(id, byId.get(id)!);
    for (const edge of up) if (!seen.has(edge.to)) {
      seen.add(edge.to);
      from.set(edge.to, id);
      if (edge.parameter) arrivedThrough.set(edge.to, edge.parameter);
      if (facts.get(edge.to)?.producesLayer) producers.add(edge.to);
      queue.push(edge.to);
    }
  }
  return { providers: [...providers.values()], satisfiedAt: [...satisfiedAt.values()], untrackedAt: [...untrackedAt.values()],
    openAt: [...openAt.values()] };
};
