import { Block } from "../terminal/blocks.js";
import { classifyFailure } from "../commands/failure-classification.js";
import { SyncConflicted } from "@smolai/skit-core/library/sync";
import { InteractionEvent } from "./interaction-recorder.js";

const scope = [
  { value: "global", label: "Global", hint: "every repository on this machine" },
  { value: "repo", label: "Only this repository", hint: "~/work/review-tools" },
];

/**
 * Every frame the CLI draws around output, as the events that produce it, so the replay draws
 * each exactly as a journey would. Instructions use the same Blocks as notes, and remain visible in JSON mode.
 */
export const frameGallery: ReadonlyArray<{
  readonly name: string;
  readonly events: readonly InteractionEvent[];
}> = [
  { name: "Command line", events: [InteractionEvent.Command({ line: "skit sync --apply" })] },
  {
    name: "Note",
    events: [
      InteractionEvent.Note({
        title: "Source updates",
        body: [
          Block.Status({ tone: "ok", text: ["swyxio/skills is up to date."] }),
          Block.Status({ tone: "info", text: ["review-tools has 1 new Skill."] }),
        ],
      }),
    ],
  },
  {
    name: "Instruction",
    events: [
      InteractionEvent.Instruction({
        title: "Approve this login in your browser",
        body: [
          Block.Note({
            text: [
              "Open ",
              { code: "https://registry.example/activate" },
              " and enter the code ",
              { emph: "ABCD EFGH" },
              ".",
            ],
          }),
        ],
      }),
    ],
  },
  {
    name: "Step",
    events: [
      InteractionEvent.Step({
        index: 2,
        total: 3,
        title: "Review other installed skills and copies",
        body: [Block.Note({ text: ["Found 5 other installed skills in 5 locations."] })],
      }),
    ],
  },
  {
    name: "Status line",
    events: [InteractionEvent.StatusStarted({ message: "Downloading 3 Skill copies" })],
  },
  {
    name: "Select prompt",
    events: [
      InteractionEvent.PromptShown({
        kind: "select",
        message: "Where should this change apply?",
        choices: scope,
      }),
    ],
  },
  {
    name: "Multiselect prompt",
    events: [
      InteractionEvent.PromptShown({
        kind: "multiselect",
        message: "Choose a copy to add, or mark Remove",
        choices: [
          { value: "cli-ux", label: "cli-ux", hint: "~/.agents/skills/cli-ux", selected: true },
          { value: "review", label: "review", hint: "~/.claude/skills/review" },
          {
            value: "docs",
            label: "docs",
            hint: "already in the Library",
            disabled: true,
          },
        ],
      }),
    ],
  },
  {
    name: "Confirm prompt",
    events: [
      InteractionEvent.PromptShown({
        kind: "confirm",
        message: "Apply these changes?",
        choices: [],
      }),
    ],
  },
  {
    name: "Answered prompt",
    events: [
      InteractionEvent.PromptShown({
        kind: "select",
        message: "Where should this change apply?",
        choices: scope,
      }),
      InteractionEvent.PromptAnswered({ answer: "global" }),
    ],
  },
  {
    name: "Failure",
    events: [
      InteractionEvent.Failure({
        failure: classifyFailure(
          new SyncConflicted({
            conflicts: [
              {
                _tag: "CollectionChanged",
                key: "cli-ux",
                label: "cli-ux",
                resolution: "take-remote",
              },
            ],
          }),
        ),
      }),
    ],
  },
];
