import { Schema } from "effect";
import { CollectionId, Hash } from "@smolai/skit-core";
import { CommandAction } from "./command-actions.js";

export const SetupUndoOutput = Schema.Struct({
  operationId: Schema.String,
  planId: Schema.optionalKey(Hash),
  status: Schema.Literals(["ready", "conflicted", "undone", "already-undone"]),
  phase: Schema.Literals(["preview", "applied", "stale", "failed"]),
  conflicts: Schema.Array(Schema.String),
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
