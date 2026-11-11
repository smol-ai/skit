import { describeFailure } from "../terminal/failure.js";
import {
  LibraryAuditInvalid,
  LibraryAuditInvalidReason,
} from "@smolai/skit-core/library/audit/failures";
import { schemaFailure } from "../platform/schema-failure.js";

export const libraryAuditFailure = ({ path, line, reason }: LibraryAuditInvalid) =>
  describeFailure({
    summary: [
      `Invalid Library audit log at ${path}${line === undefined ? "" : `:${line}`}: ${LibraryAuditInvalidReason.match(
        reason,
        {
          SchemaInvalid: ({ failure }) => schemaFailure(failure),
          EventIdentityChanged: ({ eventId }) =>
            `event ${eventId} differs from the event already saved with that identity`,
        },
      )}`,
    ],
    next:
      reason._tag === "EventIdentityChanged"
        ? ["Keep the audit log and report the conflicting event before retrying."]
        : ["Back up " + path + ", then correct the invalid record and retry."],
  });
