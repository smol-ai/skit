import {
  LibraryAuditInvalid,
  LibraryAuditInvalidReason,
} from "@smolai/skit-core/library/audit/failures";
import { schemaFailure } from "./schema-failure";

export const libraryAuditFailure = ({ path, line, reason }: LibraryAuditInvalid) => ({
  message: `Invalid Library audit log at ${path}${line === undefined ? "" : `:${line}`}: ${LibraryAuditInvalidReason.match(
    reason,
    {
      SchemaInvalid: ({ failure }) => schemaFailure(failure),
      EventIdentityChanged: ({ eventId }) =>
        `event ${eventId} differs from the event already saved with that identity`,
    },
  )}`,
  remediation:
    reason._tag === "EventIdentityChanged"
      ? "Keep the audit log and report the conflicting event before retrying."
      : `Back up ${path}, then correct the invalid record and retry.`,
});
