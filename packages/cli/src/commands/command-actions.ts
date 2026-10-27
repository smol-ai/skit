import { Schema } from "effect";

/** Concrete process arguments; an advertised action is a choice, never mutation authority. */
export const CommandAction = Schema.Struct({
  rel: Schema.String,
  argv: Schema.Array(Schema.String),
  effect: Schema.Literals(["read", "write"]),
});
export type CommandAction = typeof CommandAction.Type;
