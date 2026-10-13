// Runtime-agnostic contracts and Artifact behavior required by Registry consumer capabilities.
// The Registry Worker imports this entry, so nothing reachable from it may touch the Node platform
// layer (`platform/layer.ts`, `platform/link-stat.ts`, `@effect/platform-node`, or `node:fs`).
// `lint/universal-entry.test.ts` walks the import graph to keep that true.
export * from "./build-info.js";
export * from "./distribution/api-contracts.js";
export * from "./library/library-contracts.js";
export {
  LibraryHead,
  LibraryManifestAnyVersion,
  LibraryReadResponse,
} from "./library/library-contracts-v4.js";
export * from "./library/entity-ids.js";
export * from "./library/snapshot-archive-universal.js";
export * from "./auditing/skill-audit.js";
export * from "./contracts.js";
export * from "./artifact/descriptor.js";
export * from "./shared/skit-error.js";
export * from "./failures.js";
export * from "./harnesses/contracts.js";
export * from "./harnesses/frontmatter.js";
export * from "./invocation/conformance.js";
export * from "./shared/json.js";
export * from "./distribution/registry-identity.js";
export * from "./schemas.js";
