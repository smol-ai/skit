import { Schema } from "effect";
import { RecoveryInspection } from "@smolai/skit-core/library";

import { CommandAction } from "../../commands/command-actions.js";

export const RecoveryList = Schema.Struct({
  operations: Schema.Array(
    Schema.Struct({ operationId: Schema.String, actions: Schema.Array(CommandAction) }),
  ),
});
export const RecoveryOutput = Schema.Struct({
  ...RecoveryInspection.fields,
  phase: Schema.Literals([
    "inspection",
    "preview",
    "restored",
    "partial",
    "conflicted",
    "stale",
    "failed",
  ]),
  failure: Schema.optionalKey(Schema.String),
  actions: Schema.Array(CommandAction),
});

export function recoveryActions(home: string, operationId: string, previewPlanId?: string) {
  const command = ["skit", "library", "recovery"];
  const context = ["--home", home, "--json"];
  return [
    {
      rel: "inspect",
      argv: [...command, "inspect", operationId, ...context],
      effect: "read" as const,
    },
    {
      rel: "preview-restore",
      argv: [...command, "restore", operationId, ...context],
      effect: "read" as const,
    },
    ...(previewPlanId
      ? [
          {
            rel: "apply-restore",
            argv: [...command, "restore", operationId, "--apply", previewPlanId, ...context],
            effect: "write" as const,
          },
        ]
      : []),
  ];
}

export type RecoveryList = typeof RecoveryList.Type;
export type RecoveryOutput = typeof RecoveryOutput.Type;

export const recoveryOutputContracts = {
  recoveryList: { id: "skit.recovery.list.v1", schema: RecoveryList },
  recovery: { id: "skit.recovery.v1", schema: RecoveryOutput },
} as const;
