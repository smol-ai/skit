import { Schema } from "effect";
import { PluginManifestInvalidReason } from "./plugin-failures.js";

export const SourceDiscoveryDiagnostic = Schema.Union([
  Schema.Struct({
    code: Schema.Literal("plugin-manifest-invalid"),
    path: Schema.String,
    reason: PluginManifestInvalidReason,
  }),
  Schema.Struct({
    code: Schema.Literal("plugin-member-held"),
    path: Schema.String,
    skillName: Schema.String,
    retainedPath: Schema.String,
  }),
]);
export type SourceDiscoveryDiagnostic = typeof SourceDiscoveryDiagnostic.Type;
