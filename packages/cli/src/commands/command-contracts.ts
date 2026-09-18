import { Schema } from "effect";

const CommandEffects = Schema.Struct({
  capabilities: Schema.Array(Schema.String),
  subprocesses: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const CommandDescription = Schema.Struct({
  path: Schema.Array(Schema.String),
  summary: Schema.String,
  stability: Schema.Literals(["stable", "experimental"]),
  effects: CommandEffects,
  outputSchemas: Schema.Array(Schema.String),
  successExitCodes: Schema.Array(Schema.Number),
  errorExitCodes: Schema.Array(Schema.Number),
  interactive: Schema.Boolean,
  flags: Schema.Record(Schema.String, Schema.Struct({ type: Schema.String })),
});
export type CommandDescription = typeof CommandDescription.Type;
