import { Schema } from "effect";
import { Hash } from "../../shared/hash.js";
import { OperationId } from "../entity-ids.js";

export const LibraryAuditChange = Schema.Struct({
  entity: Schema.Literals([
    "collection",
    "skill",
    "version",
    "binding",
    "projection",
    "custody",
    "library",
  ]),
  id: Schema.String,
  action: Schema.String,
  before: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  digest: Schema.optionalKey(Hash),
});
export interface LibraryAuditChange extends Schema.Schema.Type<typeof LibraryAuditChange> {}

export const LibraryAuditEvent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  eventId: OperationId,
  occurredAt: Schema.String,
  type: Schema.String,
  workflow: Schema.String,
  imported: Schema.optionalKey(Schema.Boolean),
  changes: Schema.Array(LibraryAuditChange),
});
export interface LibraryAuditEvent extends Schema.Schema.Type<typeof LibraryAuditEvent> {}
