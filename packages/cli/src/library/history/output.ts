import { LibraryAuditEvent } from "@smolai/skit-core";
import { Schema } from "effect";

const HistoryResult = Schema.Struct({ events: Schema.Array(LibraryAuditEvent) });
export type HistoryResult = typeof HistoryResult.Type;

export const historyOutputContracts = {
  libraryHistory: { id: "skit.library.history.v1", schema: HistoryResult },
} as const;
