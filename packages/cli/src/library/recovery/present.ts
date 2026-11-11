import { Block } from "../../terminal/blocks.js";
import { recoveryFactReason } from "./failures.js";
import type { RecoveryList, RecoveryOutput } from "./output.js";

export const renderRecoveryList = (data: RecoveryList): Block[] =>
  data.operations.length
    ? [
        Block.List({
          items: data.operations.map((operation) => ({ text: [operation.operationId] })),
        }),
      ]
    : [Block.Status({ tone: "info", text: ["No saved-file recovery operations."] })];

export const renderRecovery = (data: RecoveryOutput): Block[] => [
  Block.Fields({
    rows: [
      {
        label: "File recovery",
        value: [data.phase, { dim: " (enabled Skills and settings are unchanged)" }],
      },
    ],
  }),
  ...data.entries.map((entry) =>
    Block.Group({
      title: entry.name,
      children: [
        Block.Fields({
          rows: [
            { label: "Status", value: [entry.status] },
            { label: "Path", value: [{ dim: entry.path }] },
            { label: "Reason", value: [recoveryFactReason(entry.reason)] },
            { label: "Saved", value: [{ dim: entry.recoveryPath }] },
          ],
        }),
      ],
    }),
  ),
  ...(data.legacy
    ? [
        Block.Note({
          text: [
            "Legacy move record: progress is derived from files, not moved flags; original control-file fingerprints were not recorded.",
          ],
        }),
      ]
    : []),
  ...(data.failure ? [Block.Status({ tone: "error", text: [data.failure] })] : []),
  ...(data.actions.length
    ? [
        Block.Fields({
          rows: data.actions.map((action) => ({
            label: action.rel,
            value: [{ code: action.argv.map((arg) => JSON.stringify(arg)).join(" ") }],
          })),
        }),
      ]
    : []),
];
