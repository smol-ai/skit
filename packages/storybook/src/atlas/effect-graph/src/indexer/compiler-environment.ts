import * as Schema from "effect/Schema";

export const CompilerObservation = Schema.Struct({
  operation: Schema.Literals(["readFile", "fileExists", "directoryExists", "entries", "realpath"]),
  path: Schema.String,
  digest: Schema.String,
});
export const CompilerEnvironment = Schema.Struct({
  format: Schema.Literal("compiler-environment-v1"),
  observations: Schema.Array(CompilerObservation),
});
export type CompilerEnvironment = typeof CompilerEnvironment.Type;
