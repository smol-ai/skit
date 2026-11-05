import { Schema } from "effect";
export const InstallScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global") }),
  Schema.Struct({ kind: Schema.Literal("repository"), root: Schema.String }),
]);
export type InstallScope = typeof InstallScope.Type;
