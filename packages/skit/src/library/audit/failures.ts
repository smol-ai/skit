import { Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";
import { SchemaFailure } from "../../shared/schema-issue.js";
import { OperationId } from "../entity-ids.js";
import { LibraryAuditEvent } from "./contracts.js";

export const LibraryAuditInvalidReason = Schema.TaggedUnion({
  SchemaInvalid: { failure: SchemaFailure },
  EventIdentityChanged: {
    eventId: OperationId,
    expected: LibraryAuditEvent,
    actual: LibraryAuditEvent,
  },
});
export type LibraryAuditInvalidReason = typeof LibraryAuditInvalidReason.Type;
export class LibraryAuditInvalid
  extends Schema.TaggedError<LibraryAuditInvalid, { readonly brand: unique symbol }>()(
    "LibraryAuditInvalid",
    {
      path: Schema.String,
      line: Schema.optionalKey(Schema.Int),
      reason: LibraryAuditInvalidReason,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
