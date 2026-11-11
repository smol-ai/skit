import { Schema } from "effect";
import { ApplyFailure } from "./apply-failure.js";

/** Why setup kept existing copies after saving the desired Library choice. */
export const SetupWarningReason = Schema.TaggedUnion({
  ApplicationIncomplete: { failure: ApplyFailure },
  ReplacementMissing: { path: Schema.String },
  ReplacementChanged: { path: Schema.String },
  ReplacementUnreadable: {},
}).annotate({ identifier: "SetupWarningReason" });
export type SetupWarningReason = typeof SetupWarningReason.Type;
export const SetupWarning = Schema.Struct({ name: Schema.String, reason: SetupWarningReason });
export type SetupWarning = typeof SetupWarning.Type;
