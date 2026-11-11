import { describeFailure } from "../terminal/failure.js";
import type { FailureDescription } from "../terminal/failure.js";
import { Block } from "../terminal/blocks.js";
import { SourceRestoreInvalid } from "@smolai/skit-core/library/source-restore/failures";
import { Match } from "effect";

export const sourceRestoreFailure = (
  { reason }: SourceRestoreInvalid,
  formatFailure: (error: unknown) => FailureDescription,
) => {
  const summary = ["Cannot restore a Collection Version from its source"];
  const next = [
    "Restore access to the source, or run ",
    { code: "skit update" },
    " on the Collection, then run ",
    { code: "skit sync" },
    " again.",
  ];
  if (reason._tag === "SourceFetchFailed") {
    const cause = formatFailure(reason.failure);
    return describeFailure({
      summary,
      details: [Block.Group({ title: "Source failed", children: cause.explanation })],
      next: cause.next.length ? cause.next : next,
    });
  }
  return describeFailure({
    summary,
    details: Match.value(reason).pipe(
      Match.tagsExhaustive({
        SourceImportMissing: () => [
          Block.Note({ text: ["The manifest has no exact Source Import."] }),
        ],
        NormalizationProfiles: ({ profiles }) => [
          Block.Note({
            text: [`Collection Version needs one normalization profile; found ${profiles.length}.`],
          }),
          ...(profiles.length
            ? [Block.List({ items: profiles.map((profile) => ({ text: [{ code: profile }] })) })]
            : []),
        ],
        DescriptorMissing: () => [
          Block.Note({ text: ["Source for this Collection Version has no Descriptor."] }),
        ],
        HashMismatch: () => [
          Block.Note({
            text: ["The source files differ from the Collection Version recorded in the Library."],
          }),
        ],
      }),
    ),
    next,
  });
};
