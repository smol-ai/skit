import { AuthorSyncResult as WorkspaceSync } from "@smolai/skit-core/author";
import { Schema, Tuple } from "effect";

export const AuthorSyncResult = WorkspaceSync.mapMembers(
  Tuple.map(
    Schema.fieldsAssign({ installation_issues: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
);
