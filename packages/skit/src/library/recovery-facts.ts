import { Schema } from "effect";
import { Hash } from "../vocabulary.js";

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
