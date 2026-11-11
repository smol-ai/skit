import { FailureTypeId, type SkitFailure } from "@smolai/skit-core/shared";
import { Schema } from "effect";
import { Block } from "../terminal/blocks.js";
import { describeFailure } from "../terminal/failure.js";

export class UpdateCheckTimedOut
  extends Schema.TaggedError<UpdateCheckTimedOut, { readonly brand: unique symbol }>()(
    "UpdateCheckTimedOut",
    { source: Schema.String, timeoutMs: Schema.Int },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  override get message(): string {
    return releaseCheckFailure(this).message;
  }
}

export const releaseCheckFailure = ({ source, timeoutMs }: UpdateCheckTimedOut) =>
  describeFailure({
    summary: ["The release check timed out"],
    details: [
      Block.Fields({
        rows: [
          { label: "Request", value: [{ code: source }] },
          { label: "Timeout", value: [`${timeoutMs / 1000} seconds`] },
        ],
      }),
    ],
    next: ["Retry when the network is available."],
  });
