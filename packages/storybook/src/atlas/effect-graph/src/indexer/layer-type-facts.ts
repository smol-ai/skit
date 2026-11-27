import * as Schema from "effect/Schema";
import { CompilerEnvironment } from "./compiler-environment.ts";

const TypeMember = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  declarations: Schema.Array(Schema.String),
  declarationLocations: Schema.optionalKey(Schema.Array(Schema.Struct({ file: Schema.String, line: Schema.Int, column: Schema.Int }))),
  /** A service an `HttpRouter.Request<Kind, X>` marker stands for: needed (or failed with) per request. */
  request: Schema.optional(Schema.Literals(["Requires", "GlobalRequires", "Error", "GlobalError"])),
  /** A type parameter of a generic expression, not a service. */
  parameter: Schema.optional(Schema.Boolean),
  /** What the compiler could not name (`unknown`, `any`, an error type): the channel it is in is incomplete. */
  partial: Schema.optional(Schema.Boolean),
  /** Built from a type parameter (`R`, `Exclude<R, X>`): exact as written, but the caller decides what it stands for. */
  generic: Schema.optional(Schema.Boolean),
});

const NodeFact = Schema.Struct({
  nodeId: Schema.String,
  status: Schema.Literals(["resolved", "partial", "unresolved"]),
  role: Schema.optionalKey(Schema.Literals(["layer", "program", "carrier", "callback"])),
  typeName: Schema.optionalKey(Schema.String),
  /** A callback's channels describe its return, never the function value itself. */
  returns: Schema.optionalKey(Schema.Literals(["program", "layer"])),
  reason: Schema.optional(Schema.String),
  /** An Effect whose value is a Layer, which it produces rather than composes. */
  producesLayer: Schema.optional(Schema.Boolean),
  /** An Effect whose value is an Effect: what that inner Effect requires (a router's per-request handler). */
  innerRequires: Schema.optional(Schema.Array(Schema.String)),
  provides: Schema.Array(Schema.String),
  errors: Schema.Array(Schema.String),
  requires: Schema.Array(Schema.String),
});

const Span = Schema.Struct({ start: Schema.Int, end: Schema.Int });
/** The compiler's account of how Layers compose: effect-tsgo's Layer graph
 * rules run over the pinned checkout (`scripts/lib/layer-composition.ts`).
 * A node is a Layer expression; an edge runs from a composite to a part of it. */
const CompositionNode = Schema.Struct({
  id: Schema.String,
  file: Schema.String,
  span: Span,
  line: Schema.Int,
  column: Schema.Int,
  label: Schema.String,
  /** The source text when the node is a name (`NodePtyAdapter.layer`); its label may be the declaration it initializes. */
  name: Schema.optional(Schema.String),
  /** For a name a package declares (`NodeServices.layer`): that declaration, the Layer's identity across references. */
  library: Schema.optional(Schema.String),
  /** Who declares the node's name or callee: the checkout, Effect itself, or another package. */
  reference: Schema.optional(Schema.Literals(["module", "effect", "external"])),
  /** Written inside a function, so it can differ per call; otherwise one module-level expression. */
  local: Schema.optional(Schema.Boolean),
  /** False for a composite of Layers that is not itself one, such as `Layer.launch(x)`. */
  layer: Schema.Boolean,
  /** The member of Effect's `Layer` module a call is, resolved by the compiler (`provide`, `mergeAll`). */
  combinator: Schema.optional(Schema.String),
  /** Context bridges and captured-instance re-provision are not new service origins. */
  origin: Schema.optional(Schema.Literals(["runtime-bridge", "ambient-instance"])),
  ambientSource: Schema.optional(Schema.Struct({ file: Schema.String, start: Schema.Int, end: Schema.Int })),
  /** Requirements of the Effect that builds an unwrapped Layer, before it exists.
   * Absent means the outer Effect could not be resolved; [] means none. */
  outerRequires: Schema.optional(Schema.Array(Schema.String)),
  /** Union across returned Layer alternatives, kept separate from the outer Effect. */
  returnedRequires: Schema.optional(Schema.Array(Schema.String)),
  provides: Schema.Array(Schema.String),
  requires: Schema.Array(Schema.String),
  /** Provides that are not also required: what the Layer adds, not passes through. */
  actualProvides: Schema.Array(Schema.String),
});
const CompositionEdge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  /** factory links are uninstantiated source definitions; returned indices are
   * distinct source return sites, not a prediction of the selected branch.
   * runtime links refer to a ManagedRuntime's existing Layer context. */
  relationship: Schema.Literals(["pipe", "call", "arrayLiteral", "symbol", "factory", "returned", "runtime"]),
  index: Schema.optional(Schema.Int),
});
const LayerComposition = Schema.Struct({
  nodes: Schema.Array(CompositionNode),
  edges: Schema.Array(CompositionEdge),
  /** Graph nodes whose expression is a composition node. */
  anchors: Schema.Array(Schema.Struct({ nodeId: Schema.String, composition: Schema.String })),
});

export const LayerTypeFacts = Schema.Struct({
  sourceFingerprint: Schema.optionalKey(Schema.String),
  environment: Schema.optionalKey(CompilerEnvironment),
  format: Schema.Literals(["layer-type-facts-v1"]),
  repo: Schema.String,
  commit: Schema.String,
  compiler: Schema.Union([
    Schema.Struct({ typescript: Schema.String, tsrs: Schema.String, typescriptCommit: Schema.String, fingerprint: Schema.optionalKey(Schema.String) }),
    // Existing deployed artifacts retain the compiler that actually produced them.
    Schema.Struct({ typescript: Schema.String, effectTsgo: Schema.String }),
  ]),
  /** The extraction code that wrote this sidecar and its graph: a hash over each
   * file reachable from the extraction entry points and each package version
   * they import (`scripts/lib/extractor-fingerprint.ts`). Absent on sidecars
   * built before fingerprints, which therefore cannot vouch for current code. */
  extractor: Schema.optional(Schema.Struct({
    fingerprint: Schema.String,
    files: Schema.Record(Schema.String, Schema.String),
    packages: Schema.Record(Schema.String, Schema.String),
  })),
  projects: Schema.Array(Schema.String),
  types: Schema.Array(TypeMember),
  facts: Schema.Array(NodeFact),
  composition: Schema.optional(LayerComposition),
});
export interface LayerTypeFacts extends Schema.Schema.Type<typeof LayerTypeFacts> {}

type TypeMember = LayerTypeFacts["types"][number];
/** Where a declaration comes from, briefly: `alchemy@2.0.0-beta.77 (1070b8d)`
 * for an installed package, the file for the checkout's own. */
const origin = (path: string): string => {
  const installed = /node_modules\/(?:\.bun|\.pnpm)\/((?:@[^/+]+\+)?[^/@+]+)@([^/+_]+)(?:[^/+]*)?(?:\+([0-9a-f]{7}))?/.exec(path);
  if (installed) return `${installed[1]!.replace("+", "/")}@${installed[2]}${installed[3] ? ` (${installed[3]})` : ""}`;
  const plain = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path);
  return plain ? plain[1]! : path;
};
/** The module inside its package that declares a type (`alchemy/cloudflare/providers`). */
const modulePath = (path: string): string => {
  const inPackage = /.*node_modules\/((?:@[^/]+\/)?[^/]+)\/(.*)$/.exec(path);
  if (!inPackage) return path.replace(/\.d\.ts$|\.tsx?$/, "");
  const inner = inPackage[2]!.replace(/^(?:dist|lib|build)\/(?:(?:esm|cjs|dts|src)\/)?/, "").replace(/(?:\/index)?\.d\.[cm]?ts$|\.[cm]?js$/, "");
  return `${inPackage[1]}/${inner}`;
};
/** How each type reads on the page. A router marker's service reads "per
 * request" (global middleware's, "per request, global"), a type parameter
 * says so, and services that share a name are told apart by the package that
 * declares them, or the module within it. */
/** How a type reads on the page: its name, what role it plays in words
 * (`needed on each request`), and, when two types share the name, where it is
 * declared, which the page keeps for a hover. */
/** A long type name as it reads on the page: its head and first type argument
 * (`OperationHandler<"sessions/verify", …>`). The full name stays its identity. */
const shortTypeName = (name: string, max = 80): string => {
  if (name.length <= max) return name;
  const open = /^[\w$.]+</.test(name) ? name.indexOf("<") : -1;
  let depth = 0, quote = "";
  for (let index = open + 1; open >= 0 && index < name.length; index++) {
    const char = name[index]!;
    if (quote) { if (char === quote && name[index - 1] !== "\\") quote = ""; continue; }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if ("<([{".includes(char)) depth++;
    else if (">)]}".includes(char)) { if (depth === 0) return `${name.slice(0, open)}<…>`; depth--; }
    else if (char === "," && depth === 0) return index <= max ? `${name.slice(0, index)}, …>` : `${name.slice(0, open)}<…>`;
  }
  return `${name.slice(0, max - 1)}…`;
};

interface TypeDisplay {
  readonly name: string;
  readonly role?: string;
  readonly declaredIn?: string;
  /** Stands for something the compiler could not name, so its channel is incomplete. */
  readonly partial?: boolean;
  /** Built from a type parameter; read as written, provided by whoever supplies it. */
  readonly generic?: boolean;
}

const typeDisplays = (types: ReadonlyArray<TypeMember>): ReadonlyMap<string, TypeDisplay> => {
  const role = (type: TypeMember): string | undefined => type.parameter ? "a type parameter"
    : type.request === "Requires" ? "needed on each request"
    : type.request === "GlobalRequires" ? "needed on each request, by global middleware"
    : type.request === "Error" ? "a request can fail with it"
    : type.request === "GlobalError" ? "a request can fail with it, in global middleware" : undefined;
  const key = (type: TypeMember): string => `${type.name}\0${role(type) ?? ""}`;
  const declaredAt = (type: TypeMember): string => type.declarations.join("\0");
  const distinct = (label: (type: TypeMember) => string): Map<string, Set<string>> => {
    const sharing = new Map<string, Set<string>>();
    for (const type of types) sharing.set(label(type), new Set([...(sharing.get(label(type)) ?? []), declaredAt(type)]));
    return sharing;
  };
  const byName = distinct(key);
  const inPackage = (type: TypeMember): string | undefined => (byName.get(key(type))?.size ?? 0) > 1 && type.declarations[0]
    ? origin(type.declarations[0]) : undefined;
  const byPackage = distinct((type) => `${key(type)}\0${inPackage(type) ?? ""}`);
  return new Map(types.map((type) => {
    const declaredIn = inPackage(type) !== undefined && type.declarations[0]
      && (byPackage.get(`${key(type)}\0${inPackage(type)}`)?.size ?? 0) > 1 ? modulePath(type.declarations[0]) : inPackage(type);
    // A generic type is its own answer (`Exclude<R, Scope>`), so it reads in full.
    const display: TypeDisplay = { name: type.generic ? type.name : shortTypeName(type.name), ...(role(type) ? { role: role(type)! } : {}), ...(declaredIn ? { declaredIn } : {}),
      ...(type.partial ? { partial: true } : {}), ...(type.generic ? { generic: true } : {}) };
    return [type.id, display];
  }));
};

/** A type as one line of text (`HttpPlatform (needed on each request)`), for the claims dump and plain lists. */
const typeLabels = (types: ReadonlyArray<TypeMember>): ReadonlyMap<string, string> =>
  new Map([...typeDisplays(types)].map(([id, { name, role, declaredIn }]) =>
    [id, `${name}${role ? ` (${role})` : ""}${declaredIn ? `, from ${declaredIn}` : ""}`]));

/** A router records the errors a request can fail with in the requirements
 * channel (`Request<"Error", E>`); they are errors, not requirements. */
const requestChannels = (types: ReadonlyArray<TypeMember>) => {
  const requestErrors = new Set(types.filter((type) => type.request === "Error" || type.request === "GlobalError").map((type) => type.id));
  return (fact: { readonly requires: ReadonlyArray<string>; readonly errors: ReadonlyArray<string> }) => ({
    requires: fact.requires.filter((id) => !requestErrors.has(id)),
    errors: [...fact.errors, ...fact.requires.filter((id) => requestErrors.has(id))],
  });
};

interface ResolvedLayerTypeFact {
  readonly status: LayerTypeFacts["facts"][number]["status"];
  readonly provides: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
  readonly requires: ReadonlyArray<string>;
  readonly role?: LayerTypeFacts["facts"][number]["role"];
  readonly typeName?: string;
  readonly returns?: "program" | "layer";
}

/** Decode the native-compiler sidecar separately from the source graph. A
 * partial fact stays visible as partial evidence and never supplies a complete
 * requirements claim to the renderer. */
const indexLayerTypeFacts = (
  input: unknown, repo: string | undefined, commit: string | undefined,
  nodeIds: ReadonlySet<string>,
): { artifact: LayerTypeFacts; byNode: ReadonlyMap<string, ResolvedLayerTypeFact> } => {
  const artifact = Schema.decodeUnknownSync(LayerTypeFacts)(input);
  if (!repo || !commit || artifact.repo !== repo || artifact.commit !== commit)
    throw new Error("Layer type facts and graph provenance differ");
  const types = new Map(artifact.types.map((type) => [type.id, type]));
  if (types.size !== artifact.types.length) throw new Error("Duplicate type member IDs");
  const labels = typeLabels(artifact.types);
  const split = requestChannels(artifact.types);
  const byNode = new Map<string, ResolvedLayerTypeFact>();
  for (const fact of artifact.facts) {
    if (!nodeIds.has(fact.nodeId)) throw new Error(`Unknown graph node in Layer type facts: ${fact.nodeId}`);
    if (byNode.has(fact.nodeId)) throw new Error(`Duplicate Layer type fact: ${fact.nodeId}`);
    const names = (ids: ReadonlyArray<string>): string[] => ids.map((id) => {
      if (!types.has(id)) throw new Error(`Unknown type member in Layer type facts: ${id}`);
      return labels.get(id)!;
    });
    const channels = split(fact);
    byNode.set(fact.nodeId, {
      status: fact.status,
      ...(fact.role ? { role: fact.role } : {}),
      ...(fact.typeName ? { typeName: fact.typeName } : {}),
      ...(fact.returns ? { returns: fact.returns } : {}),
      provides: names(fact.provides),
      errors: names(channels.errors),
      requires: names(channels.requires),
    });
  }
  return { artifact, byNode };
};
