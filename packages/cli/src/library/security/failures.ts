import { FailureTypeId, type SkitFailure } from "@smolai/skit-core/shared";
import { Schema } from "effect";
import { Block } from "../../terminal/blocks.js";
import { describeFailure } from "../../terminal/failure.js";

export class FindingFingerprintInvalid
  extends Schema.TaggedError<FindingFingerprintInvalid, { readonly brand: unique symbol }>()(
    "FindingFingerprintInvalid",
    { value: Schema.String },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export const findingFingerprintFailure = ({ value }: FindingFingerprintInvalid) =>
  describeFailure({
    summary: ["Finding fingerprint is invalid"],
    details: [
      Block.Fields({ rows: [{ label: "Fingerprint", value: [{ code: value }] }] }),
      Block.Note({
        text: [
          "A fingerprint starts with ",
          { code: "sha256:" },
          " followed by 64 lowercase hexadecimal characters.",
        ],
      }),
    ],
    next: ["Copy the fingerprint from ", { code: "skit security review <skill>" }, "."],
  });
