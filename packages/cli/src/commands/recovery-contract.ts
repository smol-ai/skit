import { Schema } from "effect";
import { RecoveryInspection } from "../library-application/recovery-moves.js";

import { CommandAction } from "./command-actions.js";

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
