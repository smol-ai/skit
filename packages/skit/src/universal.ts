// The runtime-agnostic surface of skit-core: the SKIT format, its validation rules, and the
// Registry wire contracts. The Registry Worker imports this entry, so nothing reachable from it
// may touch the Node platform layer (`platform/layer.ts`, `platform/link-stat.ts`, `@effect/platform-node`, or
// `node:fs`). `lint/universal-entry.test.ts` walks the import graph to keep that true.

export * from "./universal-authoring.js";
