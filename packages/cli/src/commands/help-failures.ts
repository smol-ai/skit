import { FailureTypeId, type SkitFailure } from "@smolai/skit-core/shared";
import { Schema } from "effect";
import { describeFailure } from "../terminal/failure.js";

export class HelpDocumentMissing
  extends Schema.TaggedError<HelpDocumentMissing, { readonly brand: unique symbol }>()(
    "CLI.HelpDocumentMissing",
    { command: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export const helpDocumentFailure = ({ command }: HelpDocumentMissing) =>
  describeFailure({
    summary: ["No help document for ", { code: command || "skit" }],
    next: ["Reinstall SKIT; its help documents are missing."],
  });
