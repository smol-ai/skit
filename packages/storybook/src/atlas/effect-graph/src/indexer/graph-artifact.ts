import * as Schema from "effect/Schema";
import { LayerTypeFacts } from "./layer-type-facts.ts";
import { GraphRoot } from "./graph-root.ts";

const Location = Schema.Struct({ file: Schema.String, line: Schema.Int, column: Schema.Int });
/** Source offsets of the node's expression in `location.file`. Node ids are
 * opaque; anything matching nodes to source reads this instead. Artifacts
 * published before spans were recorded omit it. */
const Span = Schema.Struct({ start: Schema.Int, end: Schema.Int });
const Node = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["root", "layer", "effect", "service"]),
  /** Compiler identity is separate from the syntax walker's node kind. */
  role: Schema.optionalKey(Schema.Literals(["layer", "program", "carrier", "callback"])),
  typeName: Schema.optionalKey(Schema.String),
  /** Syntax boundary used to collapse helpers inside a program body without asserting execution timing. */
  body: Schema.optionalKey(Schema.Literals(["function", "generator"])),
  label: Schema.String,
  location: Location,
  span: Schema.optional(Span),
  typeSource: Schema.optional(Schema.Literals(["effect-tsgo", "unresolved"])),
  expansion: Schema.optional(Schema.Literals(["dynamic", "depth-limit"])),
  /** Source traversal limits are separate from compiler type resolution and display depth. */
  extractionIssue: Schema.optionalKey(Schema.Literals(["opaque-call", "unbound-callback", "unresolved-reference", "unsupported-expression", "recursive-call"])),
  /** A known library implementation outside the source archive, not a failed application lookup. */
  sourceBoundary: Schema.optionalKey(Schema.Literal("library")),
  /** What the source made it: a command in a command tree, or the handler a Worker runs per event. */
  sourceRole: Schema.optionalKey(Schema.Literals(["command", "handler"])),
  scope: Schema.optional(Schema.Literals(["isolate", "invocation", "global", "location"])),
  binding: Schema.optional(Schema.Literals(["unbound"])),
  /** For a name (identifier or property access): what it resolved to. `module`
   * is a declaration in the archive, `local` a variable declared in an
   * enclosing function, `parameter` a parameter of one, `effect` a member of
   * Effect's own `Layer` or `Effect` module, and `external` anything the
   * archive does not declare, such as a package API. */
  origin: Schema.optionalKey(Schema.Literals(["runtime-bridge", "ambient-instance"])),
  reference: Schema.optional(Schema.Literals(["module", "local", "parameter", "effect", "external"])),
  /** For a name the archive declares at module level: `file:line:column` of
   * the value it resolves to. Every place the name is written is that one value. */
  declaration: Schema.optional(Schema.String),
  /** For a name bound at a call (a parameter, a local): a hash of the source
   * text it was bound to. Two expansions of one function body are one value
   * only where every name they resolve was bound to the same thing. */
  bound: Schema.optional(Schema.String),
  /** A name bound to `yield* x`: the result of running x, which flows on as
   * a value. x's requirements are met where it runs, not where this goes. */
  value: Schema.optional(Schema.Literals(["yielded"])),
  /** For a call of a function the archive declares: `file:line:column` of that function. */
  calls: Schema.optional(Schema.String),
  /** For such a call named by what it is bound to (`ports`): the call as written, on one line
   * (`apiPorts(clients, schemaApply, env)`). */
  written: Schema.optional(Schema.String),
  /** For an entry point built inside a function: `file:line:column` of that function, whose
   * callers supply what the entry still needs. */
  inside: Schema.optional(Schema.String),
});
const Edge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  /** `pipe`, `call` and `arrayLiteral` are the compiler's composition
   * (`compiler-composition.ts`); the others are the source walker's.
   * `fallback` is the Layer used when this one fails to build. */
  kind: Schema.Literals(["provides", "requires", "provideMerge", "providedTo", "launch", "merge", "provide", "uses", "unwrap", "branch", "acquire", "release", "replaces", "pipe", "call", "arrayLiteral", "fallback", "factory", "returned", "runtime"]),
  /** Structural callback containment does not assert deferred execution. Raw kinds remain available. */
  meaning: Schema.optionalKey(Schema.Literals(["runs", "callback", "contains", "provides"])),
  location: Location,
  /** Drawn from an argument through this parameter, whose type is generic:
   * what the argument requires and the parameter's type does not name is
   * erased from the types past this edge. */
  parameter: Schema.optional(Schema.Struct({ id: Schema.String, name: Schema.String, location: Location })),
});
export type GraphLocation = typeof Location.Type;
export type GraphSpan = typeof Span.Type;
export type GraphNode = typeof Node.Type;
export type GraphEdge = typeof Edge.Type;
export interface LayerGraph {
  readonly nodes: ReadonlyArray<GraphNode>;
  readonly edges: ReadonlyArray<GraphEdge>;
  readonly extractionModel?: "source-composition-v2";
}

/** A repo's graphs at one commit, built locally from its pinned checkout. */
export const GraphArtifact = Schema.Struct({
  format: Schema.Literal("application-graph-v2"),
  repo: Schema.String,
  commit: Schema.String,
  /** Compiler facts travel with the exact graph they describe. Older published
   * generations and repos without a compiler build omit them. */
  types: Schema.optionalKey(LayerTypeFacts),
  graphs: Schema.Array(Schema.Struct({
    name: Schema.String,
    entryFile: Schema.String,
    /** The function a runtime root is written in; absent for a module-level root. */
    within: Schema.optional(Schema.String),
    /** A runtime in an instance field initializer is created with each instance, not at module load. */
    instanceOf: Schema.optionalKey(Schema.String),
    root: GraphRoot,
    graph: Schema.Struct({ nodes: Schema.Array(Node), edges: Schema.Array(Edge), extractionModel: Schema.optionalKey(Schema.Literal("source-composition-v2")) }),
  })),
});
export type GraphArtifact = typeof GraphArtifact.Type;
