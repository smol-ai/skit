import { Option } from "effect";
import { Flag } from "effect/cli";

/** Plain CLI choices map to the existing saved setup decisions. */
export const duplicatesFlag = Flag.ChoiceWithValue("duplicates", [
  ["import-only", "retain-only"],
  ["keep-both", "keep-both"],
  ["back-up-symlinks", "retire-aliases"],
  ["back-up-copies", "preserve-duplicates"],
] as const).pipe(
  Flag.withDescription(
    "Choose what happens to other copies: import-only imports without enabling; keep-both enables alongside them; back-up-symlinks enables and moves redundant symlinks into recovery; back-up-copies enables and moves identical global copies into recovery.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);
