import { describeFailure } from "../terminal/failure.js";
import { SyncInputInvalid } from "@smolai/skit-core/library/sync/failures";
import { Match } from "effect";

export const syncInputFailure = ({ reason }: SyncInputInvalid) =>
  Match.value(reason).pipe(
    Match.tagsExhaustive({
      SkillSelectionNotUnique: ({ query, matches }) =>
        describeFailure({
          summary: [`Device Skill ${query} matched ${matches.length} Skills.`],
          next: ["Choose a unique Skill name or Skill ID."],
        }),
      CollectionSelectionNotUnique: ({ query, matches }) =>
        describeFailure({
          summary: [`Device Collection ${query} matched ${matches.length} Collections.`],
          next: ["Choose a unique Collection label or Collection ID."],
        }),
      AccountEnabledListWithDeviceSelection: () =>
        describeFailure({
          summary: [
            "--keep-enabled changes what is enabled for the account and cannot be combined with a device selection.",
          ],
          next: ["Choose either --keep-enabled or a device selection, then sync again."],
        }),
    }),
  );
