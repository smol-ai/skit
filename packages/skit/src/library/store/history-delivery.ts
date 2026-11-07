import { Schema } from "effect";
import { OperationId } from "../entity-ids.js";
import { LibraryAuditEvent } from "../audit/audit-log.js";

/** Identity and attribution belong to the whole composed write, across its state checkpoints. */
export const HistoryAction = Schema.Struct({
  eventId: OperationId,
  occurredAt: Schema.String,
  workflow: Schema.String,
});
export type HistoryAction = typeof HistoryAction.Type;

/** Private storage envelope v1. Older state files without this field have no pending deliveries. */
export const HistoryDelivery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  pending: Schema.Array(
    Schema.Struct({
      event: LibraryAuditEvent,
      operationIds: Schema.Array(OperationId),
    }),
  ),
});
export type HistoryDelivery = typeof HistoryDelivery.Type;

/** Keep existing domain/extension fields while validating the reserved storage metadata. */
export const StateEnvelope = Schema.StructWithRest(
  Schema.Struct({ historyDelivery: Schema.optionalKey(HistoryDelivery) }),
  [Schema.JsonObject],
);
