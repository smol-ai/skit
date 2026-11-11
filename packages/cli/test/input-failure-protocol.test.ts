import { expect, test } from "vitest";
import { Schema } from "effect";
import { MissingRequirement, OptionCombinationInvalid } from "../src/commands/input-failures.js";
import { NothingToSelect } from "../src/terminal/interaction-failures.js";
import { CommandError } from "../src/commands/error-output.js";
import { classifyFailure, commandFailure } from "../src/commands/failure-classification.js";
import { Block } from "../src/terminal/blocks.js";

const optionReasons = {
  ConflictingOptions: { _tag: "ConflictingOptions", options: ["--global", "--repo"] },
  OptionConflicts: {
    _tag: "OptionConflicts",
    option: "--follow-account",
    others: ["--device-skill"],
  },
  RequiresOption: { _tag: "RequiresOption", options: ["--device-only"], required: "--apply" },
  RequiresMode: {
    _tag: "RequiresMode",
    options: ["--select-path"],
    modes: ["--review", "--compare", "--apply"],
  },
  OptionsNotAllowed: {
    _tag: "OptionsNotAllowed",
    mode: "--compare",
    options: ["--duplicates"],
    allowed: ["--select-path"],
  },
  SetupPlanIdInvalid: { _tag: "SetupPlanIdInvalid", value: "short", option: "--review" },
  ReviewedSelectionRequired: { _tag: "ReviewedSelectionRequired" },
  ReviewedChoicesChanged: {
    _tag: "ReviewedChoicesChanged",
    reviewedReviewId: "approved",
    currentReviewId: "current",
  },
} satisfies {
  [K in OptionCombinationInvalid["reason"]["_tag"]]: Extract<
    OptionCombinationInvalid["reason"],
    { _tag: K }
  >;
};
const missingReasons = {
  PublishVersion: { _tag: "PublishVersion" },
  InstalledEditSubject: { _tag: "InstalledEditSubject" },
  SkillSelection: { _tag: "SkillSelection", action: "enable" },
  SecuritySubject: { _tag: "SecuritySubject", action: "accept" },
  SecurityAcceptanceFields: { _tag: "SecurityAcceptanceFields", missing: ["--rationale"] },
} satisfies {
  [K in MissingRequirement["reason"]["_tag"]]: Extract<MissingRequirement["reason"], { _tag: K }>;
};

const failures = [
  ...Object.values(optionReasons).map((reason) => new OptionCombinationInvalid({ reason })),
  ...Object.values(missingReasons).map((reason) => new MissingRequirement({ reason })),
  new NothingToSelect({ reason: { _tag: "LibrarySkills" } }),
  new NothingToSelect({ reason: { _tag: "EnabledSkills" } }),
  new NothingToSelect({ reason: { _tag: "EnabledSkills", scope: { kind: "global" } } }),
  new NothingToSelect({
    reason: { _tag: "EnabledSkills", scope: { kind: "repository", root: "/work/review tools" } },
  }),
];

test.each(failures)(
  "$_tag/$reason._tag keeps input facts and reconstructs its blocks",
  (failure) => {
    const classified = classifyFailure(failure);
    const wire = Schema.encodeSync(CommandError)({
      code: classified.code,
      cause: classified.cause,
    });
    expect(wire.cause).toEqual([
      { _tag: "Fail", error: { _tag: failure._tag, reason: failure.reason } },
    ]);
    const decoded = Schema.decodeUnknownSync(CommandError)(JSON.parse(JSON.stringify(wire)));
    expect(commandFailure(decoded.cause).presentation).toEqual(classified.presentation);
  },
);

test.each(["--apply", "--review", "--compare"] as const)(
  "an invalid plan ID names the actual %s option",
  (option) => {
    const formatted = classifyFailure(
      new OptionCombinationInvalid({
        reason: { _tag: "SetupPlanIdInvalid", value: "short", option },
      }),
    );
    expect(formatted.explanation[0]).toEqual(
      Block.Status({ tone: "error", text: [{ code: option }, " requires a full setup plan ID"] }),
    );
    expect(formatted.next).toContainEqual({ code: option });
  },
);

test("empty enabled selection retains its repository scope instead of claiming none are enabled anywhere", () => {
  const formatted = classifyFailure(failures.at(-1));
  expect(formatted.explanation[0]).toEqual(
    Block.Status({
      tone: "error",
      text: ["No Skills are enabled in repository ", { path: "/work/review tools" }],
    }),
  );
});
