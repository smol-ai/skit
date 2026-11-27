/** Working-tree integration of upstream scripts/layer-graph.ts; no corpus registry or renderer. */
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
import * as Schema from "effect/Schema";
import { compilerProgram } from "./indexer/compiler-program.ts";
import { graphArtifactOf } from "./indexer/graph-artifact-build.ts";
import { providerScopes, layerDefinition } from "./indexer/provider-scopes.ts";
import { commandQueries } from "./indexer/commands.ts";
import { serviceDeclarations, providerQueries } from "./indexer/services.ts";
import { graphQueries, probeTypeFacts } from "../scripts/lib/type-facts.ts";
import { graphCompilerVersions } from "../scripts/lib/graph-compiler.ts";
import { applyCompilerFacts, type RawGraphs } from "../scripts/lib/compiler-graph.ts";
import { withCompilerComposition } from "./indexer/compiler-composition.ts";
import { foldCallContexts } from "./indexer/call-contexts.ts";
import { requirementSources } from "./indexer/requirement-sources.ts";
import { LayerTypeFacts } from "./indexer/layer-type-facts.ts";
import type { WorkerSourceFile } from "./indexer/worker-layer-graph.ts";
import type { GraphArtifact } from "./indexer/graph-artifact.ts";

export const extract = (directory: string, sources: ReadonlyArray<WorkerSourceFile>, entries: ReadonlyArray<string>, tree: { file: string; name: string }, owners: ReadonlyArray<{file: string; name: string}>, objects: ReadonlyArray<{prefix: string; name: string}> = []) => {
  const root = resolve(directory), start = performance.now(), compiled = compilerProgram(root, sources);
  try {
    const services = serviceDeclarations(compiled, owners, objects), commands = commandQueries(compiled, tree.file, tree.name), providers = providerQueries(compiled);
    const artifact = JSON.parse(JSON.stringify(graphArtifactOf({ ...compiled, program: { ...compiled.program,
      paths: compiled.program.paths.filter(path => entries.some(entry => path === `${root}/${entry}`)) } }, "skit", "working-tree"))) as GraphArtifact & RawGraphs;
    if (!artifact) throw new Error("No application roots discovered");
    const vendor = fileURLToPath(new URL("../", import.meta.url));
    const files = Object.fromEntries(readdirSync(vendor, { recursive: true }).filter(path => typeof path === "string" && path.endsWith(".ts")).sort()
      .map(path => [String(path), createHash("sha256").update(readFileSync(resolve(vendor, String(path)))).digest("hex")]));
    const extractor = { fingerprint: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files, packages: { tsrs: "0.20.0-ts7.1.0-beta" } };
    const sourceFingerprint = createHash("sha256").update(JSON.stringify([...sources].sort((a,b) => a.path.localeCompare(b.path)))).digest("hex");
    const scopes = providerScopes(compiled, entries, commands.flatMap(command => command.scopes));
    const queries = [...graphQueries(artifact, root), ...commands, ...providers, ...scopes.queries];
    const configs = [...new Set(queries.flatMap(query => compiled.configFor(query.file) ?? []))];
    const probed = probeTypeFacts({ repo: root, repoName: "skit", head: "working-tree", dirty: true, extractor, queries, compact: true,
      toolchainVersions: graphCompilerVersions(), projectFor: compiled.configFor, projectOf: compiled.openProjects(configs), projectPaths: configs,
      textOf: file => { const text = compiled.readFile(file); if (text === undefined) throw new Error(`Missing source: ${file}`); return text; } });
    if (!("types" in probed)) throw new Error("Expected compact compiler facts");
    const facts = { ...probed, facts: probed.facts.map(fact => { if (!fact.nodeId) throw new Error("Missing graph query identity"); return { ...fact, nodeId: fact.nodeId }; }) };
    const allFacts = new Map(facts.facts.map(fact => [fact.nodeId, fact]));
    const types = new Map(facts.types.map(type => [type.id, type]));
    const location = (node: {file: string; line: number}) => ({ file: node.file.startsWith(`${root}/`) ? relative(root, node.file) : node.file, line: node.line });
    const member = (id: string, fallback: {file: string; line: number}) => {
      const type = types.get(id); if (!type) throw new Error(`Type missing: ${id}`);
      return { key: id, name: type.name, declarations: type.declarations, ...location(type.declarationLocations?.[0] ?? fallback), incomplete: Boolean(type.partial || type.generic) };
    };
    const providerRows = providers.map(query => {
      const fact = allFacts.get(query.graphNodeId);
      return { name: query.name, ...location(query), requires: (fact?.requires ?? []).map(id => member(id, query)),
        provides: (fact?.provides ?? []).map(id => member(id, query)), incomplete: !fact || fact.status !== "resolved" || Boolean(fact.reason),
        notes: !fact ? ["Provider contract not resolved"] : fact.reason ? [fact.reason] : [] };
    });
    const issues = new Map<string, {file: string; line: number; reason: string}>();
    for (const named of artifact.graphs) for (const node of named.graph.nodes) if (node.extractionIssue || node.expansion === "depth-limit") {
      const issue = { ...location(node.location), reason: node.extractionIssue ?? "depth-limit" };
      issues.set(`${issue.file}:${issue.line}:${issue.reason}`, issue);
    }
    const byQuery = new Map(queries.map(query => [query.graphNodeId, query]));
    for (const fact of facts.facts) if (fact.status !== "value" && (fact.status === "partial" || fact.status === "unresolved" || fact.reason?.includes("unresolved"))) {
      const query = byQuery.get(fact.nodeId);
      if (query) { const issue = { ...location(query), reason: fact.reason ?? "Partial requirement contract" };
        issues.set(`${issue.file}:${issue.line}:${issue.reason}`, issue); }
    }
    applyCompilerFacts(artifact, facts);
    const typed = Schema.decodeUnknownSync(LayerTypeFacts)({ ...facts, facts: facts.facts.filter(fact => fact.status !== "value") });
    const merged = withCompilerComposition(artifact.graphs, typed), graphs = merged.graphs.map(named => foldCallContexts(named, { parameters: true }));
    const byNode = new Map([...typed.facts, ...merged.facts].map(fact => [fact.nodeId, fact]));
    const commandRows = commands.map(query => {
      const contract = allFacts.get(query.graphNodeId), required = contract?.requires ?? [];
      const candidates = graphs.flatMap(graph => graph.graph.nodes.filter(node => node.location.file === relative(root, query.file)
        && node.span && node.span.start >= query.span[0] && node.span.end <= query.span[1] && byNode.get(node.id)?.role === "program")
        .map(node => ({ graph, node, fact: byNode.get(node.id)! })));
      // Match the enclosing program's exact contract, never a partially overlapping helper.
      const complete = candidates.filter(candidate => candidate.fact.requires.length === required.length
        && required.every(id => candidate.fact.requires.includes(id)));
      const outer = complete.filter(candidate => complete.every(other => candidate.node.span!.start <= other.node.span!.start
        && candidate.node.span!.end >= other.node.span!.end));
      const selected = outer.length === 1 ? outer[0] : undefined;
      const requirements = required.map(id => {
        const found = selected && selected.fact.requires.includes(id) ? requirementSources(selected.graph.graph, byNode, selected.node.id, id) : undefined;
        const origins = found?.providers.map(provider => ({ name: provider.origin.label, ...location(provider.origin.location) })) ?? [];
        const stops = found ? [
          ...found.satisfiedAt.map(node => ({ reason: node.location.file === selected?.graph.entryFile || byNode.get(node.id)?.typeName === "Command" ? "Provided at the command boundary, origin not resolved" : "Requirement is absent at this boundary; provider origin not resolved", ...location(node.location) })),
          ...found.untrackedAt.map(node => ({ reason: "Requirement crosses an untracked contract", ...location(node.location) })),
          ...found.openAt.map(node => ({ reason: "Provider path remains open", ...location(node.location) }))]
          : [{ reason: "Handler provider path not resolved", ...location(query) }];
        return { ...member(id, query), providers: origins, stops };
      });
      const endLine = compiled.readFile(query.file)!.slice(0, query.span[1]).split("\n").length;
      return { command: query.command, ...location(query), scopes: query.scopes.map(scope => ({ ...location(scope), name: scope.name, id: scope.graphNodeId })), requirements,
        incompleteErrors: !contract || Boolean(contract.reason) || (contract.errors ?? []).some(id => types.get(id)?.partial),
        notes: !contract ? ["Command contract not resolved"] : contract.reason ? [contract.reason] : [],
        stops: [...issues.values()].filter(issue => issue.file === relative(root, query.file) && issue.line >= query.line && issue.line <= endLine) };
    });
    const composition = facts.composition;
    const anchors = new Map(composition?.anchors.map(anchor => [anchor.nodeId, anchor.composition]));
    const scopeRows = [...commands.flatMap(command => command.scopes), ...scopes.application].map(scope => ({
      id: scope.graphNodeId, ...location(scope), name: scope.name,
      roots: (scopes.roots.find(row => row.scope === scope.graphNodeId)?.queries ?? []).flatMap(id => anchors.get(id) ?? []),
    }));
    const layers = composition?.nodes.map(node => ({ id: node.id, ...location(node), name: node.name ?? node.label,
      provides: node.provides.map(id => member(id, node)), requires: node.requires.map(id => member(id, node)),
      outerRequires: node.outerRequires?.map(id => member(id, node)), actualProvides: node.actualProvides, layer: node.layer, combinator: node.combinator, origin: node.origin,
      local: Boolean(node.local), reference: node.reference, span: node.span, definition: layerDefinition(compiled, node.file, node.span) })) ?? [];
    return { tracing: { layers, edges: composition?.edges ?? [], scopes: [...new Map(scopeRows.map(scope => [scope.id, scope])).values()],
      application: scopes.application.map(scope => scope.graphNodeId) }, sourceFingerprint, environment: compiled.environment(), services, providers: providerRows, commands: commandRows, stops: [...issues.values()], compiler: graphCompilerVersions(), elapsedMs: performance.now() - start };
  } finally { compiled.close(); }
};
