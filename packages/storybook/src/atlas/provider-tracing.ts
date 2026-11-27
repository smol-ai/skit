import { Schema } from "effect";
import { MapMember, MapSource, type RequirementTrace } from "./data.ts";

const Layer = Schema.Struct({
  ...MapSource.fields,
  id: Schema.String,
  name: Schema.String,
  provides: Schema.Array(MapMember),
  requires: Schema.Array(MapMember),
  actualProvides: Schema.Array(Schema.String),
  outerRequires: Schema.optionalKey(Schema.Array(MapMember)),
  layer: Schema.Boolean,
  combinator: Schema.optionalKey(Schema.String),
  origin: Schema.optionalKey(Schema.String),
  reference: Schema.optionalKey(Schema.String),
  local: Schema.Boolean,
  definition: Schema.optionalKey(
    Schema.Struct({
      ...MapSource.fields,
      name: Schema.String,
      parameter: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const Scope = Schema.Struct({
  ...MapSource.fields,
  id: Schema.String,
  name: Schema.String,
  roots: Schema.Array(Schema.String),
});
export const ProviderComposition = Schema.Struct({
  layers: Schema.Array(Layer),
  edges: Schema.Array(
    Schema.Struct({
      from: Schema.String,
      to: Schema.String,
      relationship: Schema.Literals([
        "pipe",
        "call",
        "arrayLiteral",
        "symbol",
        "factory",
        "returned",
        "runtime",
      ]),
      index: Schema.optionalKey(Schema.Int),
    }),
  ),
  scopes: Schema.Array(Scope),
  application: Schema.Array(Schema.String),
});
type LayerNode = typeof Layer.Type;
type ProviderScope = typeof Scope.Type;
type Trace = typeof RequirementTrace.Type;
type Part = { readonly id: string; readonly consumed: boolean; readonly feedsBase: boolean };
type Origin = {
  readonly node: LayerNode;
  readonly internal: readonly ProviderScope[];
  readonly factories: readonly LayerNode[];
  readonly uncertain: boolean;
  readonly construction: readonly (typeof MapMember.Type)[];
};

/** Resolve only source-proven provider scopes, never the unrestricted declaration inventory. */
export function traceProviders(composition: typeof ProviderComposition.Type) {
  const nodes = new Map(composition.layers.map((node) => [node.id, node]));
  const edges = Map.groupBy(composition.edges, (edge) => edge.from);
  const scopes = new Map(composition.scopes.map((scope) => [scope.id, scope]));
  const inputs = (id: string) => edges.get(id) ?? [];
  const calls = (id: string) =>
    inputs(id)
      .filter((edge) => edge.relationship === "call")
      .toSorted((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const part = (id: string, consumed = false, feedsBase = false): Part => ({
    id,
    consumed,
    feedsBase,
  });
  // Native Layer composition: output passes through merges/provideMerge, never provide inputs.
  const parts = (id: string): Part[] => {
    const node = nodes.get(id),
      own = inputs(id);
    const symbol = own.filter((edge) => edge.relationship === "symbol");
    if (symbol.length) return symbol.map((edge) => part(edge.to));
    const pipe = own.find((edge) => edge.relationship === "pipe");
    if (pipe) {
      const steps: string[] = [];
      for (let at: string | undefined = pipe.to; at && !steps.includes(at);) {
        steps.unshift(at);
        at = inputs(at).find((edge) => edge.relationship === "pipe")?.to;
      }
      const [base, ...operations] = steps;
      return [
        ...(base ? [part(base)] : []),
        ...operations.flatMap((operation) =>
          calls(operation).map((edge) =>
            part(
              edge.to,
              nodes.get(operation)?.combinator === "provide",
              nodes.get(operation)?.combinator === "provideMerge",
            ),
          ),
        ),
      ];
    }
    const arguments_ = calls(id);
    if (node?.combinator && arguments_.length)
      return arguments_.map((edge, index) =>
        part(
          edge.to,
          node.combinator === "provide" && index > 0,
          node.combinator === "provideMerge" && index > 0,
        ),
      );
    return own
      .filter((edge) =>
        ["factory", "returned", "runtime", "arrayLiteral"].includes(edge.relationship),
      )
      .map((edge) => part(edge.to));
  };
  const supplies = (id: string, key: string) =>
    nodes.get(id)?.provides.some((member) => member.key === key);
  const origins = (
    root: string,
    key: string,
    seen: ReadonlySet<string> = new Set(),
    internal: readonly ProviderScope[] = [],
    factories: readonly LayerNode[] = [],
    uncertain = false,
    construction: readonly (typeof MapMember.Type)[] = [],
  ): Origin[] => {
    const node = nodes.get(root);
    if (!node || seen.has(root) || !supplies(root, key)) return [];
    const next = new Set([...seen, root]),
      children = parts(root);
    const alternatives = inputs(root).filter((edge) => edge.relationship === "returned");
    const partial = uncertain || alternatives.some((edge) => !supplies(edge.to, key));
    const outputs = children.filter((child) => !child.consumed && supplies(child.id, key));
    if (outputs.length)
      return outputs.flatMap((child) =>
        origins(
          child.id,
          key,
          next,
          [
            ...children
              .slice(children.indexOf(child) + 1)
              .filter((part) => part.consumed || part.feedsBase)
              .map((part) => ({
                id: part.id,
                name: nodes.get(part.id)?.name ?? part.id,
                file: node.file,
                line: node.line,
                roots: [part.id],
              })),
            ...internal,
          ],
          inputs(root).some((edge) => edge.relationship === "factory" && edge.to === child.id)
            ? [...factories, node]
            : factories,
          partial,
          [...construction, ...(node.outerRequires ?? [])],
        ),
      );
    // Captured contexts and generic parameters are not constructors.
    return node.origin || node.reference === "parameter" || node.definition?.parameter
      ? []
      : [{ node, internal, factories, uncertain: partial, construction }];
  };
  return (required: readonly (typeof MapMember.Type)[], commandScopes: readonly string[]) => {
    const selected = [...commandScopes, ...composition.application].flatMap(
      (id) => scopes.get(id) ?? [],
    );
    const traces = new Map<string, Trace>();
    const active = new Set<string>();
    const resolve = (
      requirement: typeof MapMember.Type,
      incoming: readonly ProviderScope[],
    ): string => {
      const contexts = [...new Map(incoming.map((scope) => [scope.id, scope])).values()];
      const id = JSON.stringify([requirement.key, contexts.map((scope) => scope.id)]);
      if (traces.has(id)) return id;
      if (active.has(id)) return id;
      active.add(id);
      let matched: Origin[] = [],
        remaining = contexts;
      let failed: ProviderScope | undefined;
      let reason: string | undefined;
      let alternatives = false;
      for (let index = 0; index < contexts.length; index++) {
        const scope = contexts[index];
        if (!scope) continue;
        if (!scope.roots.length) {
          failed = scope;
          break;
        }
        if (
          scope.roots.some((root) => nodes.get(root)?.provides.some((member) => member.incomplete))
        ) {
          failed = scope;
          reason =
            "A reachable provider has an incomplete output contract; it may override this requirement";
          break;
        }
        const eligible = scope.roots.filter((root) => supplies(root, requirement.key));
        if (!eligible.length) continue;
        remaining = contexts.slice(index);
        alternatives = eligible.length !== scope.roots.length;
        matched = eligible.flatMap((root) => origins(root, requirement.key));
        if (!matched.length) failed = scope;
        break;
      }
      const unique = [
        ...new Map(
          matched.map((origin) => {
            const source = origin.node.definition ?? origin.node;
            return [
              `${source.file}:${source.line}:${source.name}:${origin.factories.map((factory) => factory.id).join(",")}:${origin.node.requires.map((r) => r.key).join(",")}`,
              origin,
            ];
          }),
        ).values(),
      ];
      const providers = unique.map(({ node, internal, factories, construction }) => {
        const source = node.definition ?? node;
        const requires = [
          ...new Map(
            [...node.requires, ...construction].map((member) => [member.key, member]),
          ).values(),
        ];
        return {
          name: source.name,
          file: source.file,
          line: source.line,
          requires,
          incomplete: requires.some((member) => member.incomplete),
          notes: [
            ...factories.map((factory) => `Constructed at ${factory.file}:${factory.line}`),
            ...(node.reference === "external"
              ? ["External Layer implementation is outside this source snapshot"]
              : []),
          ],
          dependencies: requires.map((member) =>
            resolve(member, [...internal, ...remaining.slice(1)]),
          ),
        };
      });
      const ambiguous =
        providers.length > 1 || alternatives || unique.some((origin) => origin.uncertain);
      const source = failed ?? requirement;
      traces.set(id, {
        ...requirement,
        id,
        providers: ambiguous ? [] : providers,
        candidates: ambiguous ? providers : [],
        stops:
          providers.length === 1 && !ambiguous
            ? []
            : [
                {
                  file: source.file,
                  line: source.line,
                  reason: ambiguous
                    ? "Ambiguous provider origins in this command's composition; candidates are not a selected provider"
                    : (reason ??
                      (failed
                        ? failed.roots.length
                          ? "The scoped Layer supplies this type, but a captured context or parameter has no constructor origin"
                          : "The command's provider callback has no statically resolved Layer return"
                        : "No reachable command or runtime Layer output supplies this exact service identity")),
                },
              ],
      });
      active.delete(id);
      return id;
    };
    const roots = required.map((requirement) => resolve(requirement, selected));
    return {
      requirements: roots.flatMap((id) => traces.get(id) ?? []),
      traces: [...traces.values()],
      application: composition.application.flatMap((id) => scopes.get(id) ?? []),
    };
  };
}
