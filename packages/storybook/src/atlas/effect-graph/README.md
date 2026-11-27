# Effect graph extractor

Vendored from Tim’s effect-grep at `a464a64c1f5a90fcca3803edc671054c364cb38e`.
Only the source/typed dependency extraction pipeline is included. No CLI, MCP server,
corpus inventory, cache tooling or overview renderer is included. Files retain upstream
formatting. Atlas generation owns the JSON reader and UI separately.

The pinned `tsrs` SDK and native compiler are the Storybook package’s devDependency.
This folder alone follows the same lint/format exclusions as vendored Fluid.

## Source manifest

Paths below are both local (relative to this folder) and upstream paths at the pinned
commit. “Whole” means byte-for-byte at baseline; subsequent corrections are recorded
below. Counts include comments and blank lines, excluding this README.

| Local / upstream path | Baseline lines | Taken |
|---|---:|---|
| `scripts/lib/compiler-graph.ts` | 135 | Whole |
| `scripts/lib/graph-compiler.ts` | 61 | Whole |
| `scripts/lib/graph-value-type.ts` | 7 | Whole |
| `scripts/lib/layer-composition.ts` | 357 | Whole |
| `scripts/lib/type-facts.ts` | 605 | Whole |
| `src/indexer/call-contexts.ts` | 185 | Whole |
| `src/indexer/compiler-composition.ts` | 396 | Whole |
| `src/indexer/compiler-environment.ts` | 12 | Whole |
| `src/indexer/compiler-filesystem.ts` | 147 | Whole |
| `src/indexer/compiler-program.ts` | 334 | Whole |
| `src/indexer/composition-hooks.ts` | 177 | Whole |
| `src/indexer/composition-walker.ts` | 840 | Whole |
| `src/indexer/graph-artifact-build.ts` | 34 | Whole |
| `src/indexer/graph-artifact.ts` | 101 | Whole |
| `src/indexer/graph-builder.ts` | 58 | Whole |
| `src/indexer/graph-root.ts` | 33 | Whole |
| `src/indexer/layer-graph.ts` | 3 | Whole |
| `src/indexer/layer-type-facts.ts` | 252 | Whole |
| `src/indexer/requirement-sources.ts` | 229 | Whole |
| `src/indexer/runtime-graph.ts` | 216 | Whole |
| `src/indexer/syntax.ts` | 42 | Whole |
| `src/indexer/worker-layer-graph.ts` | 233 | Whole |

Baseline total: **4,457 lines**, 22 files.

Omitted: `src/corpus.ts`, `scripts/lib/artifact-cache.ts`,
`src/indexer/composition-overview.ts`, `src/indexer/composition-contracts.ts`. Their
few required definitions will be isolated by the first local correction; no imports
into the sibling effect-grep checkout are permitted.

## Local corrections

1. **Package/tooling boundary:** SDK imports use the public `tsrs/sync`, `tsrs/fs`
   and `tsrs/ast` exports. The compiler executable and SDK fingerprint resolve from
   the installed pinned package, without a sibling checkout, corpus registry or
   cache module. `src/conventions.ts` keeps only the small configuration shape and
   production-source/package predicates. `stackLabel` is isolated at its only use;
   no overview/contracts renderer is copied. Atlas runs under Node, so `inNode`
   does not spawn effect-grep’s absent Bun bridge. Source extraction rules otherwise
   stay unchanged. Keep extractor helpers and types private when Atlas has no
   external caller for them.

2. **Workspace source resolution:** build exact export-to-source paths from workspace
   package manifests, using the same published export targets as Atlas’s existing
   reader. Apply them to binding and per-package typed programs, preserving each
   package’s parsed options, source includes and ambient declarations. No package
   files/configs are rewritten on disk. This avoids identity/implementation loss at
   `dist/*.d.ts` boundaries.

3. **Worker entry form:** recognize `export default { … } satisfies ExportedHandler`
   as a Worker root, following each event implementation with invocation scope.
   Existing Alchemy class discovery is unchanged. The explicit source type is
   required; arbitrary exported objects are not guessed to be Workers.

4. **Command contracts/provision:** preserve Effect CLI `Command` E/R as carrier
   facts instead of erasing them as data. These are distinct from Layer output
   contracts. Walk `Command.provide` in direct/pipe forms, retaining provider
   callbacks as unbound evidence; a callback is not a proven provider origin.
   Existing Layer/provider path matching remains authoritative. `commands.ts` walks
   the actual exported command tree to produce pre-provision query anchors and
   full command paths, retaining every generic-factory occurrence.

5. **Full declaration inventory:** `services.ts` reads every production tag’s
   declared interface, including nested operation groups and unreachable/private
   tags. Source anchors accompany declarations and operations. Caller-supplied
   symbol-checked store owners add plain Owner entries by resolved export identity;
   services are not guessed from capitalized names. No command-to-owner ledger.
   `providerQueries` inventories named Layer values and factories beyond reached
   roots, so server providers and aliases remain visible as definitions.

6. **Generation entry:** `src/extract.ts` adapts upstream `scripts/layer-graph.ts`
   to a supplied working-tree snapshot. It retains the original JSON/mutable graph
   boundary and typed composition/requirement matching, projecting source-anchored
   definitions, contracts and explicit stops for Atlas. Provider-path selection
   uses a unique enclosing program with the exact command requirement set; partial
   overlaps and ambiguous contexts remain unresolved. No corpus/CLI/MCP server.

7. **Scoped command provider evidence:** walk the exported command tree to retain
   each leaf's ordered `Command.provide` scopes, including inherited group providers.
   Resolve provider callbacks to their source return expressions without evaluating
   configuration; probe those Layer roots. Retain the runtime's outer
   `Effect.provide` scopes, typed Layer composition and source declaration anchors
   for Atlas's scoped resolver. The unrestricted provider inventory remains separate;
   it is never the set of eligible production providers. Multiple return sites stay
   alternatives. Conditional Layer expressions retain both returned arms, rather
   than pretending their union selects a constructor. Declaration anchors distinguish
   unbound Layer parameters from named constructors and external use sites. Syntax
   walker issues are retained independently of this evidence.

8. **Layer construction requirements:** expose the native probe's existing
   `outerRequires` alongside a Layer's own contract. Atlas keeps requirements of
   the Effect constructing an unwrapped Layer even when a returned branch merely
   re-exposes a captured value. No constructor dependency is erased by descending
   to a returned Layer.

9. **Source descriptions:** retain a tag declaration's directly attached JSDoc
   prose for the Services list. Read the native syntax node's documented start;
   variable declarations use their containing statement. No descriptions are
   authored, inherited from unrelated interfaces, or guessed from filenames.

## Refresh

Copy the manifest files from the named revision without formatting, then reapply
each correction listed here. Keep the source/typed graph, partial channels, source
anchors and unresolved requirement answers; never turn missing evidence into an
empty successful contract. Record the updated manifest and line total.

## Current manifest

Source paths are relative to effect-grep at the pinned commit; local correction files
have no separate upstream counterpart. Counts include comments and blank lines.

| Local file | Source path at a464a64 | Current lines | Taken |
|---|---|---:|---|
| `scripts/lib/compiler-graph.ts` | `scripts/lib/compiler-graph.ts` | 135 | Corrected |
| `scripts/lib/graph-compiler.ts` | `scripts/lib/graph-compiler.ts` | 22 | Corrected |
| `scripts/lib/graph-value-type.ts` | `scripts/lib/graph-value-type.ts` | 7 | Corrected |
| `scripts/lib/layer-composition.ts` | `scripts/lib/layer-composition.ts` | 368 | Corrected |
| `scripts/lib/type-facts.ts` | `scripts/lib/type-facts.ts` | 619 | Corrected |
| `src/conventions.ts` | `local correction` | 7 | Local correction |
| `src/extract.ts` | `scripts/layer-graph.ts (adapted)` | 110 | Local correction |
| `src/indexer/call-contexts.ts` | `src/indexer/call-contexts.ts` | 185 | Whole |
| `src/indexer/commands.ts` | `local correction` | 81 | Local correction |
| `src/indexer/compiler-composition.ts` | `src/indexer/compiler-composition.ts` | 396 | Whole |
| `src/indexer/compiler-environment.ts` | `src/indexer/compiler-environment.ts` | 12 | Whole |
| `src/indexer/compiler-filesystem.ts` | `src/indexer/compiler-filesystem.ts` | 147 | Corrected |
| `src/indexer/compiler-program.ts` | `src/indexer/compiler-program.ts` | 332 | Corrected |
| `src/indexer/composition-hooks.ts` | `src/indexer/composition-hooks.ts` | 177 | Corrected |
| `src/indexer/composition-walker.ts` | `src/indexer/composition-walker.ts` | 844 | Corrected |
| `src/indexer/graph-artifact-build.ts` | `src/indexer/graph-artifact-build.ts` | 34 | Corrected |
| `src/indexer/graph-artifact.ts` | `src/indexer/graph-artifact.ts` | 101 | Whole |
| `src/indexer/graph-builder.ts` | `src/indexer/graph-builder.ts` | 58 | Whole |
| `src/indexer/graph-root.ts` | `src/indexer/graph-root.ts` | 33 | Corrected |
| `src/indexer/layer-graph.ts` | `src/indexer/layer-graph.ts` | 3 | Corrected |
| `src/indexer/layer-type-facts.ts` | `src/indexer/layer-type-facts.ts` | 251 | Corrected |
| `src/indexer/provider-scopes.ts` | `local correction` | 93 | Local correction |
| `src/indexer/requirement-sources.ts` | `src/indexer/requirement-sources.ts` | 229 | Corrected |
| `src/indexer/runtime-graph.ts` | `src/indexer/runtime-graph.ts` | 216 | Corrected |
| `src/indexer/services.ts` | `local correction` | 101 | Local correction |
| `src/indexer/syntax.ts` | `src/indexer/syntax.ts` | 42 | Corrected |
| `src/indexer/worker-layer-graph.ts` | `src/indexer/worker-layer-graph.ts` | 250 | Corrected |

Current total: **4,853 lines**, 27 files (limit: 5,000).
