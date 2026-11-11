import { Match, Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core/shared";
import { describeFailure } from "../terminal/failure.js";
import { CliError } from "effect/cli";
import { Block } from "../terminal/blocks.js";

export class CommandLineInvalid
  extends Schema.TaggedError<CommandLineInvalid>()("CommandLineInvalid", {
    errors: Schema.Array(CliError.NonShowHelpErrors),
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class OptionCombinationInvalid
  extends Schema.TaggedError<OptionCombinationInvalid, { readonly brand: unique symbol }>()(
    "OptionCombinationInvalid",
    {
      reason: Schema.TaggedUnion({
        ConflictingOptions: { options: Schema.Array(Schema.String) },
        OptionConflicts: { option: Schema.String, others: Schema.Array(Schema.String) },
        RequiresOption: { options: Schema.Array(Schema.String), required: Schema.String },
        RequiresMode: { options: Schema.Array(Schema.String), modes: Schema.Array(Schema.String) },
        OptionsNotAllowed: {
          mode: Schema.String,
          options: Schema.Array(Schema.String),
          allowed: Schema.Array(Schema.String),
        },
        SetupPlanIdInvalid: {
          value: Schema.String,
          option: Schema.Literals(["--apply", "--review", "--compare"]),
        },
        ReviewedSelectionRequired: {},
        ReviewedChoicesChanged: { reviewedReviewId: Schema.String, currentReviewId: Schema.String },
      }),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export class MissingRequirement
  extends Schema.TaggedError<MissingRequirement, { readonly brand: unique symbol }>()(
    "MissingRequirement",
    {
      reason: Schema.TaggedUnion({
        PublishVersion: {},
        InstalledEditSubject: {},
        SkillSelection: { action: Schema.Literals(["enable", "disable"]) },
        SecuritySubject: { action: Schema.Literals(["review", "accept"]) },
        SecurityAcceptanceFields: {
          missing: Schema.Array(Schema.Literals(["--finding", "--principal", "--rationale"])),
        },
      }),
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
}

export const InputFailure = Schema.Union([
  CommandLineInvalid,
  OptionCombinationInvalid,
  MissingRequirement,
]);
export type InputFailure = typeof InputFailure.Type;

export const inputFailure = (failure: InputFailure) =>
  Match.value(failure).pipe(
    Match.tagsExhaustive({
      CommandLineInvalid: ({ errors }) =>
        describeFailure({
          summary: ["Command line is invalid"],
          details: [Block.List({ items: errors.map((error) => ({ text: [error.message] })) })],
          next: ["Run ", { code: "skit --help" }, " to review command usage."],
        }),
      OptionCombinationInvalid: ({ reason }) =>
        Match.value(reason).pipe(
          Match.tagsExhaustive({
            ConflictingOptions: ({ options }) =>
              describeFailure({
                summary: ["These options cannot be used together"],
                details: [
                  Block.List({ items: options.map((option) => ({ text: [{ code: option }] })) }),
                ],
                next: ["Choose one of the listed options, then retry."],
              }),
            OptionConflicts: ({ option, others }) =>
              describeFailure({
                summary: ["Cannot combine ", { code: option }, " with these options"],
                details: [
                  Block.List({ items: others.map((option) => ({ text: [{ code: option }] })) }),
                ],
                next: ["Remove ", { code: option }, " or the listed options, then retry."],
              }),
            RequiresOption: ({ options, required }) =>
              describeFailure({
                summary: ["These options require ", { code: required }],
                details: [
                  Block.List({ items: options.map((option) => ({ text: [{ code: option }] })) }),
                ],
                next: ["Add ", { code: required }, " or remove the listed options, then retry."],
              }),
            RequiresMode: ({ options, modes }) =>
              describeFailure({
                summary: ["Selection options require a setup mode"],
                details: [
                  Block.Group({
                    title: "Selections",
                    children: [
                      Block.List({
                        items: options.map((option) => ({ text: [{ code: option }] })),
                      }),
                    ],
                  }),
                  Block.Group({
                    title: "Modes",
                    children: [
                      Block.List({ items: modes.map((mode) => ({ text: [{ code: mode }] })) }),
                    ],
                  }),
                ],
                next: ["Choose a mode for these selections, or remove the selection options."],
              }),
            OptionsNotAllowed: ({ mode, options, allowed }) =>
              describeFailure({
                summary: [{ code: mode }, " does not accept these selection options"],
                details: [
                  Block.Group({
                    title: "Unsupported options",
                    children: [
                      Block.List({
                        items: options.map((option) => ({ text: [{ code: option }] })),
                      }),
                    ],
                  }),
                  Block.Group({
                    title: "Allowed selection options",
                    children: [
                      Block.List({
                        items: allowed.map((option) => ({ text: [{ code: option }] })),
                      }),
                    ],
                  }),
                ],
                next: ["Remove the unsupported selection options, then retry."],
              }),
            SetupPlanIdInvalid: ({ value, option }) =>
              describeFailure({
                summary: [{ code: option }, " requires a full setup plan ID"],
                details: [Block.Fields({ rows: [{ label: "Value", value: [{ code: value }] }] })],
                next: [
                  "Copy ",
                  { code: "planId" },
                  " from ",
                  { code: "skit setup --json" },
                  " and pass it with ",
                  { code: option },
                  ".",
                ],
              }),
            ReviewedSelectionRequired: () =>
              describeFailure({
                summary: ["Explicit selections require a reviewed setup plan"],
                next: [
                  "Run ",
                  { code: "skit setup --review <planId>" },
                  " with these selections, then pass its ",
                  { code: "reviewId" },
                  " with ",
                  { code: "--reviewed" },
                  " when applying.",
                ],
              }),
            ReviewedChoicesChanged: () =>
              describeFailure({
                summary: ["The reviewed setup choices changed"],
                next: ["Review these choices again before applying."],
              }),
          }),
        ),
      MissingRequirement: ({ reason }) =>
        Match.value(reason).pipe(
          Match.tagsExhaustive({
            PublishVersion: () =>
              describeFailure({
                summary: [{ code: "skit author publish" }, " requires ", { code: "--version" }],
                next: ["Pass ", { code: "--version" }, ", then retry."],
              }),
            InstalledEditSubject: () =>
              describeFailure({
                summary: [
                  "Using ",
                  { code: "--from" },
                  " with ",
                  { code: "skit update" },
                  " requires ",
                  { code: "<skill>" },
                ],
                next: [
                  "Pass ",
                  { code: "<skill>" },
                  ", then retry. ",
                  { code: "skit list --json" },
                  " lists the Library's Skills.",
                ],
              }),
            SkillSelection: ({ action }) =>
              describeFailure({
                summary: [
                  { code: `skit ${action}` },
                  " requires ",
                  { code: "<skill-or-collection>" },
                ],
                next: [
                  "Choose a Skill or Collection from ",
                  { code: "skit list --json" },
                  ". Add ",
                  { code: "--global" },
                  " or ",
                  { code: "--repo <path>" },
                  " to choose the scope, and ",
                  { code: "--all" },
                  " for a whole Collection.",
                ],
              }),
            SecuritySubject: ({ action }) =>
              describeFailure({
                summary: [{ code: `skit security ${action}` }, " requires ", { code: "<skill>" }],
                next: [
                  "Pass ",
                  { code: "<skill>" },
                  "; ",
                  { code: "skit list --json" },
                  " lists the Library's Skills.",
                ],
              }),
            SecurityAcceptanceFields: ({ missing }) =>
              describeFailure({
                summary: ["Security acceptance is missing required options"],
                details: [
                  Block.List({ items: missing.map((option) => ({ text: [{ code: option }] })) }),
                ],
                next: [
                  "Pass the missing options, then retry. ",
                  { code: "skit security review <skill> --json" },
                  " lists each finding's fingerprint.",
                ],
              }),
          }),
        ),
    }),
  );
