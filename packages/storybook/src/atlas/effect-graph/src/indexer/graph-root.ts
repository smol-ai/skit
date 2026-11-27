import * as Schema from "effect/Schema";
import type { GraphConventions } from "../conventions.ts";

/** The calls an application graph starts from, by the name their module gives them. */
export const RootCall = Schema.Literals([
  "Layer.launch", "Layer.build", "Layer.buildWithScope", "ManagedRuntime.make", "NodeRuntime.runMain", "BunRuntime.runMain",
  "Alchemy.Stack", "Cloudflare.Worker", "ExportedHandler", "Atom.AtomRuntime", "LayerNode.compile",
]);
export type RootCall = typeof RootCall.Type;

/** What a graph starts from, as the walker found it, so no reader parses it back out of the graph's name. */
export const GraphRoot = Schema.Struct({
  call: RootCall,
  /** The class a Worker is declared as, or the variable a typed `AtomRuntime` is assigned to. */
  declared: Schema.optionalKey(Schema.String),
  /** The name a stack or Worker deploys under: its string-literal first argument. */
  deployedAs: Schema.optionalKey(Schema.String),
  /** The function whose calls each build this root: `makeAppRuntime → ManagedRuntime.make`. */
  through: Schema.optionalKey(Schema.String),
});
export type GraphRoot = typeof GraphRoot.Type;

const RUNTIME_CALLS: ReadonlyArray<RootCall> = ["Layer.launch", "Layer.build", "Layer.buildWithScope", "ManagedRuntime.make",
  "NodeRuntime.runMain", "BunRuntime.runMain", "Alchemy.Stack"];

/** The calls that start a runtime graph wherever they are written; OpenCode's `LayerNode.compile` is one too.
 * Workers are found by their class declaration and AtomRuntimes by their type annotation, not by a call. */
export const runtimeCalls = (conventions: GraphConventions): ReadonlySet<string> =>
  new Set([...RUNTIME_CALLS, ...(conventions.frameworks.includes("opencode") ? ["LayerNode.compile" as const] : [])]);

/** A root that runs a program; the others build or deploy a Layer. */
export const runsProgram = (call: string | null): call is "NodeRuntime.runMain" | "BunRuntime.runMain" =>
  call === "NodeRuntime.runMain" || call === "BunRuntime.runMain";
