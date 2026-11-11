import { InstallScope } from "@smolai/skit-core/library";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core/shared";
import { Match, Schema } from "effect";
import { describeFailure } from "./failure.js";

/** The person went back with Escape or interrupted the prompt. */
export class PromptCancelled
  extends Schema.TaggedError<PromptCancelled>()("PromptCancelled", {
    prompt: Schema.String,
    reason: Schema.Literals(["back", "interrupt"]),
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}

export class SelectionCancelled
  extends Schema.TaggedError<SelectionCancelled>()("SelectionCancelled", {
    subject: Schema.Literals(["Skill", "Harness", "Package", "Collection", "Destination", "Login"]),
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class NothingToSelect
  extends Schema.TaggedError<NothingToSelect, { readonly brand: unique symbol }>()(
    "NothingToSelect",
    {
      reason: Schema.TaggedUnion({
        EnabledSkills: { scope: Schema.optionalKey(InstallScope) },
        LibrarySkills: {},
      }),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
}

export const InteractionFailure = Schema.Union([
  PromptCancelled,
  SelectionCancelled,
  NothingToSelect,
]);
export type InteractionFailure = typeof InteractionFailure.Type;

export const interactionFailure = (failure: InteractionFailure) =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      PromptCancelled: ({ prompt }) =>
        describeFailure({
          summary: [prompt, " cancelled"],
          next: [
            "Run the command again to make a choice, or pass it as a flag to skip the prompt; ",
            { code: "--help" },
            " lists them.",
          ],
        }),
      SelectionCancelled: ({ subject }) =>
        describeFailure({
          summary: [subject === "Login" ? "Login cancelled" : `${subject} selection cancelled`],
          next:
            subject === "Login"
              ? ["Run ", { code: "skit auth login" }, " again when ready."]
              : ["Run the command again and make a selection, or pass the choice as an argument."],
        }),
      NothingToSelect: ({ reason }) =>
        Match.value(reason).pipe(
          Match.tagsExhaustive({
            EnabledSkills: ({ scope }) =>
              describeFailure({
                summary:
                  scope === undefined
                    ? ["No Skills are currently enabled"]
                    : scope.kind === "global"
                      ? ["No Skills are enabled globally"]
                      : ["No Skills are enabled in repository ", { path: scope.root }],
                next: ["Run ", { code: "skit list" }, " to check what is enabled."],
              }),
            LibrarySkills: () =>
              describeFailure({
                summary: ["The local Library contains no Skills"],
                next: ["Run ", { code: "skit add <source>" }, " to add Skills, then try again."],
              }),
          }),
        ),
    }),
  );
