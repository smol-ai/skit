import { Schema } from "effect";
import { OperationId } from "../entity-ids.js";

/** Identity and attribution belong to the whole composed write, across its state checkpoints. */
export const HistoryAction = Schema.Struct({
  eventId: OperationId,
  occurredAt: Schema.String,
  workflow: Schema.String,
});
export type HistoryAction = typeof HistoryAction.Type;
