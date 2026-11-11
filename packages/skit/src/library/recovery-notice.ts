import { Schema } from "effect";
import { OperationId } from "./entity-ids.js";

/** Best-effort recovery reports facts without changing the operation's success or failure. */
export const LibraryRecoveryNotice = Schema.TaggedUnion({
  PendingStateSaveFailed: {
    home: Schema.String,
    path: Schema.optionalKey(Schema.String),
    failure: Schema.Unknown,
  },
  BackupsStillPending: {
    home: Schema.String,
    installedSkillId: Schema.String,
    path: Schema.String,
    failure: Schema.Unknown,
  },
  SetupStopNotRecorded: {
    home: Schema.String,
    operationId: OperationId,
    failure: Schema.Unknown,
  },
  HistoryDeliveryPending: {
    home: Schema.String,
    actionId: Schema.optionalKey(OperationId),
    failure: Schema.Unknown,
  },
});
export type LibraryRecoveryNotice = typeof LibraryRecoveryNotice.Type;
