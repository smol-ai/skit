import { SyncInputInvalid } from "@smolai/skit-core/library/sync/failures";
import { Match } from "effect";

export const syncInputFailure = ({ reason }: SyncInputInvalid) =>
  Match.value(reason).pipe(
    Match.tagsExhaustive({
      SkillSelectionNotUnique: ({ query, matches }) => ({
        message: `Device Skill ${query} matched ${matches.length} Skills.`,
        remediation: "Choose a unique Skill name or Skill ID.",
      }),
      CollectionSelectionNotUnique: ({ query, matches }) => ({
        message: `Device Collection ${query} matched ${matches.length} Collections.`,
        remediation: "Choose a unique Collection label or Collection ID.",
      }),
      AccountEnabledListWithDeviceSelection: () => ({
        message:
          "Changes to the account Enabled list cannot be combined with an independent device selection.",
        remediation:
          "Choose either changes to the account Enabled list or an independent device selection, then sync again.",
      }),
    }),
  );
