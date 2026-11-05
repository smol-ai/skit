import { type ContractData } from "../../commands/output-contracts.js";

export const renderRecoveryList = (data: ContractData<"recoveryList">) =>
  data.operations.length
    ? data.operations.map((operation) => operation.operationId).join("\n")
    : "No saved-file recovery operations.";

export const renderRecovery = (data: ContractData<"recovery">) =>
  [
    `File recovery: ${data.phase} (Library bindings and settings are unchanged)`,
    ...data.entries.map(
      (entry) =>
        `${entry.name} · ${entry.status} · ${entry.path}\n  ${entry.reason}\n  Saved: ${entry.recoveryPath}`,
    ),
    ...(data.legacy
      ? [
          "Legacy move record: progress is derived from files, not moved flags; original control-file fingerprints were not recorded.",
        ]
      : []),
    ...(data.failure ? [data.failure] : []),
    ...data.actions.map(
      (action) => `${action.rel}: ${action.argv.map((arg) => JSON.stringify(arg)).join(" ")}`,
    ),
  ].join("\n");
