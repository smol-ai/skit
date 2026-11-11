import { UndoConflict } from "@smolai/skit-core/library";
import { undoConflict } from "../recovery/failures.js";
import type { ContractData } from "../../commands/output-contracts.js";
import { Block, type Change } from "../../terminal/blocks.js";
import { actionFields } from "./present.js";
import { Schema } from "effect";
import { CollectionId } from "@smolai/skit-core/universal/consumer";
import { Hash } from "@smolai/skit-core/shared";
import { CommandAction } from "../../commands/command-actions.js";

export const SetupUndoOutput = Schema.Struct({
  operationId: Schema.String,
  planId: Schema.optionalKey(Hash),
  status: Schema.Literals(["ready", "conflicted", "undone", "already-undone"]),
  phase: Schema.Literals(["preview", "applied", "stale", "failed"]),
  conflicts: Schema.Array(UndoConflict),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.Literals(["release-ownership", "restore", "remove-created"]),
    }),
  ),
  intentChanged: Schema.Boolean,
  settingsChanged: Schema.Boolean,
  sourceSelections: Schema.Array(
    Schema.Struct({
      collectionId: CollectionId,
      label: Schema.String,
      fromSnapshot: Hash,
      toSnapshot: Hash,
    }),
  ),
  backupId: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(Schema.String),
  actions: Schema.Array(CommandAction),
});

export const setupUndoActions = (home: string, operationId: string, planId?: string) => [
  {
    rel: "preview-undo",
    argv: ["skit", "library", "undo", operationId, "--home", home, "--json"],
    effect: "read" as const,
  },
  {
    rel: "inspect-files",
    argv: ["skit", "library", "recovery", "inspect", operationId, "--home", home, "--json"],
    effect: "read" as const,
  },
  ...(planId
    ? [
        {
          rel: "apply-undo",
          argv: [
            "skit",
            "library",
            "undo",
            operationId,
            "--apply",
            planId,
            "--home",
            home,
            "--json",
          ],
          effect: "write" as const,
        },
      ]
    : []),
];

export const renderSetupUndo = (data: ContractData<"setupUndo">): Block[] => {
  const restores: Change[] = [
    ...data.sourceSelections.map((source): Change => ({
      action: "update",
      label: `Restore Collection ${source.label}`,
      detail: `${source.fromSnapshot} → ${source.toSnapshot}`,
    })),
    ...(data.intentChanged
      ? [
          {
            action: "update" as const,
            label: "Restore prior enablement, versions and invocation choices",
          },
        ]
      : []),
    ...(data.settingsChanged
      ? [
          {
            action: "update" as const,
            label: "Restore prior discovery roots and repository decisions",
          },
        ]
      : []),
  ];
  return [
    Block.Fields({
      rows: [
        { label: "Setup undo", value: [data.status] },
        { label: "Operation", value: [data.operationId] },
      ],
    }),
    ...(data.files.length
      ? [
          Block.Table({
            columns: [{ title: "File change" }, { title: "Path" }],
            rows: data.files.map((file) => [[file.kind], [{ dim: file.path }]]),
          }),
        ]
      : []),
    ...(restores.length ? [Block.Changes({ items: restores })] : []),
    ...(data.conflicts.length
      ? [
          Block.Group({
            title: "Conflicts",
            children: [
              Block.List({
                items: data.conflicts.map((conflict) => ({ text: [undoConflict(conflict)] })),
              }),
            ],
          }),
        ]
      : []),
    ...(data.failure ? [Block.Status({ tone: "error", text: [data.failure] })] : []),
    Block.Note({ text: ["Collection Versions in the Library remain available."] }),
    ...(data.actions.length ? [Block.Fields({ rows: actionFields(data.actions) })] : []),
  ];
};
