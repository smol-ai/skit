import { Schema } from "effect";

/** Release identifies a pipeline build, not publication or installation provenance. */
export const BuildInfo = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("release"),
    version: Schema.NonEmptyString,
    commit: Schema.NonEmptyString,
    buildId: Schema.optionalKey(Schema.NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("dev"),
    version: Schema.NonEmptyString,
    commit: Schema.optionalKey(Schema.NonEmptyString),
    buildId: Schema.optionalKey(Schema.NonEmptyString),
  }),
]);
export type BuildInfo = typeof BuildInfo.Type;
