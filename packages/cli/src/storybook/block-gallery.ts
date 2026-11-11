import { Block } from "../terminal/blocks.js";
import { LibraryRecoveryNotice } from "@smolai/skit-core/library";
import { makeOperationId } from "@smolai/skit-core/universal/consumer";
import { systemError } from "effect/PlatformError";
import { recoveryNoticeBlocks } from "../library/recovery-notices.js";

const recoveryHome = "/home/story/.skit";
const recoveryFailure = systemError({
  _tag: "PermissionDenied",
  module: "FileSystem",
  method: "writeFileString",
  pathOrDescriptor: recoveryHome,
});
const recoveryAction = makeOperationId();

/** Every Block, each tone and each Inline form, so the look of the vocabulary can be reviewed. */
export const blockGallery: ReadonlyArray<{ readonly name: string; readonly blocks: Block[] }> = [
  ...[
    LibraryRecoveryNotice.cases.PendingStateSaveFailed.make({
      home: recoveryHome,
      path: "/home/story/.agents/skills/review",
      failure: recoveryFailure,
    }),
    LibraryRecoveryNotice.cases.BackupsStillPending.make({
      home: recoveryHome,
      installedSkillId: "installed-review",
      path: "/home/story/.agents/skills/review",
      failure: recoveryFailure,
    }),
    LibraryRecoveryNotice.cases.SetupStopNotRecorded.make({
      home: recoveryHome,
      operationId: recoveryAction,
      failure: recoveryFailure,
    }),
    LibraryRecoveryNotice.cases.HistoryDeliveryPending.make({
      home: recoveryHome,
      actionId: recoveryAction,
      failure: recoveryFailure,
    }),
  ].map((notice) => ({
    name: `Recovery notice body | ${notice._tag}`,
    blocks: [...recoveryNoticeBlocks(notice)],
  })),
  { name: "Heading", blocks: [Block.Heading({ text: "Library sync plan" })] },
  {
    name: "Status | every tone",
    blocks: [
      Block.Status({ tone: "ok", text: ["Library synced."] }),
      Block.Status({ tone: "info", text: ["Nothing to sync."] }),
      Block.Status({ tone: "warn", text: ["cli-ux differs between devices."] }),
      Block.Status({ tone: "error", text: ["Library sync stopped."] }),
    ],
  },
  {
    name: "Note | every Inline",
    blocks: [
      Block.Note({
        text: [
          "Run ",
          { code: "skit sync --apply" },
          " to apply this plan. ",
          { emph: "Nothing changes" },
          " until then. ",
          { dim: "(3 Skills, 2 devices)" },
          " Read ",
          { url: "https://skit.smol.ai" },
          ". Installed at ",
          { path: "~/.agents/skills/review" },
        ],
      }),
    ],
  },
  {
    name: "List",
    blocks: [
      Block.List({
        items: [
          { text: ["cli-ux"], detail: [{ dim: "~/.agents/skills/cli-ux" }] },
          { text: ["skill-cutter"], detail: [{ dim: "~/.claude/skills/skill-cutter" }] },
          { text: ["review"] },
        ],
      }),
    ],
  },
  {
    name: "Fields",
    blocks: [
      Block.Fields({
        rows: [
          { label: "Skill", value: ["cli-ux"] },
          { label: "Collection", value: ["swyxio/skills"] },
          { label: "Installed at", value: [{ path: "~/.agents/skills/cli-ux" }] },
          {
            label: "Differs",
            value: [
              "This device and the remote Library each changed cli-ux since they last synced, so neither copy can replace the other without losing an edit.",
            ],
          },
        ],
      }),
    ],
  },
  {
    name: "Table",
    blocks: [
      Block.Table({
        columns: [{ title: "Skill" }, { title: "Agents" }, { title: "Tokens", align: "end" }],
        rows: [
          [["cli-ux"], ["Codex, Claude Code"], ["1,240"]],
          [["skill-cutter"], ["Claude Code"], ["860"]],
          [["nvidia-skill-finder"], [{ dim: "none" }], ["12,000"]],
        ],
      }),
    ],
  },
  {
    name: "Table | multiline cells",
    blocks: [
      Block.Table({
        columns: [{ title: "Skill" }, { title: "Paths" }],
        rows: [
          [["review"], [{ path: "skills/review\narchived/review" }]],
          [["docs"], [{ path: "skills/docs" }]],
        ],
      }),
    ],
  },
  {
    name: "Wrapping | prose at the terminal width",
    blocks: [
      Block.Status({
        tone: "warn",
        text: [
          "cli-ux changed on this device and on the remote Library since they last synced. Run ",
          { code: "skit sync --apply --take-remote cli-ux" },
          " to keep the remote version, or edit it here and sync again.",
        ],
      }),
      Block.List({
        items: [
          {
            text: ["review"],
            detail: [
              {
                dim: "Reads a pull request, checks it against the repository's own conventions and suggests changes in the author's voice.",
              },
            ],
          },
        ],
      }),
    ],
  },
  {
    name: "Verbatim | copied exactly, never wrapped",
    blocks: [
      Block.Verbatim({
        text: '_skit() {\n  local cur="${COMP_WORDS[COMP_CWORD]}"\n  COMPREPLY=( $(compgen -W "add enable disable sync setup doctor list update remove" -- "$cur") )\n}\ncomplete -F _skit skit',
      }),
    ],
  },
  {
    name: "Changes | every action, nested",
    blocks: [
      Block.Changes({
        title: "Collections",
        items: [
          {
            action: "update",
            label: "swyxio/skills",
            detail: "2 Skills",
            children: [
              { action: "add", label: "docs" },
              { action: "update", label: "cli-ux" },
              { action: "remove", label: "testing" },
            ],
          },
          { action: "add", label: "review-tools", detail: "1 Skill" },
        ],
      }),
    ],
  },
  {
    name: "Group",
    blocks: [
      Block.Group({
        title: "This device",
        children: [
          Block.Changes({ items: [{ action: "update", label: "cli-ux" }] }),
          Block.Note({ text: [{ dim: "Installed copies are updated when the plan is applied." }] }),
        ],
      }),
    ],
  },
  {
    name: "Composed | a sync plan",
    blocks: [
      Block.Heading({ text: "Library sync plan" }),
      Block.Group({
        title: "This device",
        children: [
          Block.Changes({
            title: "Collections",
            items: [
              {
                action: "update",
                label: "swyxio/skills",
                children: [{ action: "update", label: "cli-ux" }],
              },
            ],
          }),
        ],
      }),
      Block.Group({
        title: "Remote Library",
        children: [Block.Note({ text: [{ dim: "No changes." }] })],
      }),
      Block.Status({
        tone: "info",
        text: ["Plan: 1 to update. Run ", { code: "skit sync --apply" }, "."],
      }),
    ],
  },
];
