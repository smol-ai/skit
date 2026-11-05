import { type ContractData } from "../../commands/output-contracts.js";
import { terminalData } from "../../terminal/text.js";

export const renderSetupUndo = (data: ContractData<"setupUndo">) =>
  [
    `Setup undo: ${data.status}`,
    `Operation: ${data.operationId}`,
    ...data.files.map((file) => `${file.kind}: ${terminalData(file.path)}`),
    ...data.sourceSelections.map(
      (source) =>
        `Restore Collection ${terminalData(source.label)}: ${source.fromSnapshot} → ${source.toSnapshot}`,
    ),
    ...(data.intentChanged ? ["Restore prior enablement, versions and invocation choices"] : []),
    ...(data.settingsChanged ? ["Restore prior discovery roots and repository decisions"] : []),
    ...data.conflicts.map((conflict) => `Conflict: ${terminalData(conflict)}`),
    ...(data.failure ? [terminalData(data.failure)] : []),
    "Retained Library artifacts remain available.",
    ...data.actions.map(
      (action) => `${action.rel}: ${action.argv.map((arg) => JSON.stringify(arg)).join(" ")}`,
    ),
  ].join("\n");

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
