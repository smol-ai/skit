import { Schema } from "effect";
import type { Effect } from "effect";

export class RuleFailed extends Schema.TaggedError<RuleFailed>()("RuleFailed", {
  rule: Schema.String,
  observed: Schema.Record(Schema.String, Schema.Unknown),
}) {}

/** A successful check becomes part of the recording; a failed check fails the run. */
export type CheckRule = (
  rule: string,
  satisfied: boolean,
  observed: { readonly [field: string]: unknown },
) => Effect.Effect<void, RuleFailed>;
