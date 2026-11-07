import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { Hash } from "../shared/hash.js";

export const RecoveryFact = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  recoveryPath: Schema.String,
  type: Schema.Literals(["Directory", "SymbolicLink"]),
  status: Schema.Literals(["saved", "at-original", "missing", "conflict"]),
  reason: Schema.String,
});
export const RecoveryInspection = Schema.Struct({
  operationId: Schema.String,
  directory: Schema.String,
  planId: Hash,
  entries: Schema.Array(RecoveryFact),
  legacy: Schema.Boolean,
});

export type RecoveryInspection = typeof RecoveryInspection.Type;

export class RecoveryInvalid
  extends Schema.TaggedError<RecoveryInvalid, { readonly brand: unique symbol }>()(
    "RecoveryInvalid",
    { detail: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get message() {
    return `Recovery cannot proceed: ${this.detail}`;
  }
  readonly remediation =
    "Inspect the saved files and their move record; keep both before resolving the conflict.";
}
