import type { GraphArtifact } from "./graph-artifact.ts";
import { workerGraphs, type WorkerSourceFile } from "./worker-layer-graph.ts";
import { runtimeGraphs } from "./runtime-graph.ts";
import { nameResolution } from "./composition-walker.ts";
import { compositionHooks } from "./composition-hooks.ts";
import { compilerProgram, inNode, type CompilerProgram } from "./compiler-program.ts";
import { NO_GRAPH_CONVENTIONS, type GraphConventions } from "../conventions.ts";

/** A repo's application graph artifact: its Cloudflare Workers and runtime
 * roots, over sources already open in a compiler session. Built locally from
 * pinned checkouts (`pnpm graphs:assets`); the Worker never runs this. */
export const graphArtifactOf = (
  compiled: CompilerProgram, repo: string, commit: string, conventions: GraphConventions = NO_GRAPH_CONVENTIONS,
): GraphArtifact | null => {
  const { program } = compiled;
  const names = nameResolution(compiled);
  const hooks = compositionHooks(names, conventions);
  const graphs = [...workerGraphs(program, names, conventions, hooks), ...runtimeGraphs(program, names, conventions, hooks)];
  return graphs.length === 0 ? null : { format: "application-graph-v2", repo, commit, graphs };
};

export const buildGraphArtifact = inNode(import.meta.url, "buildGraphArtifact", (
  repo: string,
  commit: string,
  sources: ReadonlyArray<WorkerSourceFile>,
  conventions: GraphConventions = NO_GRAPH_CONVENTIONS,
  /** The checkout `sources` were read from, which supplies installed libraries
   * and tsconfig files. Without one, sources stand alone. */
  checkout: string = "/corpus",
  pinnedConfiguration: boolean = false,
): GraphArtifact | null => {
  const compiled = compilerProgram(checkout, sources, { packageBoundaries: conventions.packageBoundaries, pinnedConfiguration });
  try { return graphArtifactOf(compiled, repo, commit, conventions); } finally { compiled.close(); }
});
