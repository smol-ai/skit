import { Schema } from "effect";

export const SourceDiscoveryDiagnostic = Schema.Struct({
  code: Schema.Literals(["plugin-manifest-invalid", "plugin-member-held"]),
  path: Schema.String,
  message: Schema.String,
});
export type SourceDiscoveryDiagnostic = typeof SourceDiscoveryDiagnostic.Type;
