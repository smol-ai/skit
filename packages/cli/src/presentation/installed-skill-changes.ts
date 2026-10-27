import type {
  InstalledSkillChange,
  InstalledSkillChangeResult,
  SetupVersionChoice,
} from "../workflows/library/setup-contract.js";
import { terminalData } from "./terminal-text.js";

export function renderInstalledSkillChange(
  fact: InstalledSkillChange,
  displayPath: (path: string) => string = (path) => path,
) {
  const label = {
    unchanged: fact.metadataChanged
      ? "Align the installed copy with the selected version"
      : "Already matches Library",
    "incoming-update": "Update untouched copy from Library",
    "local-only": "Keep local edits active",
    competing: "Local and Library both changed; choose the active version",
    protected: `Resolve ownership: ${fact.reason ?? "ownership is uncertain"}`,
    "native-delete": "Keep native deletion",
  }[fact.status];
  return `${terminalData(fact.name)} · ${terminalData(label)} · ${terminalData(displayPath(fact.path))}`;
}

export function renderSetupVersionChoice(
  choice: SetupVersionChoice,
  facts: readonly InstalledSkillChange[],
  displayPath: (path: string) => string = (path) => path,
) {
  const name = facts.find((fact) => fact.skillId === choice.skillId)?.name ?? choice.skillId;
  const version =
    choice.version === "retained"
      ? "retained Library version"
      : `current copy at ${terminalData(displayPath(choice.path!))}`;
  return `Use ${version} for ${terminalData(name)}; preserve displaced copies in recovery`;
}

export function renderReviewedChanges(
  fact: InstalledSkillChange,
  choices: readonly SetupVersionChoice[],
  displayPath: (path: string) => string = (path) => path,
) {
  return fact.status !== "native-delete" &&
    choices.some((choice) => choice.skillId === fact.skillId)
    ? `${terminalData(fact.name)} · Install selected version · ${terminalData(displayPath(fact.path))}`
    : renderInstalledSkillChange(fact, displayPath);
}

export function renderChangeResult(outcome: InstalledSkillChangeResult) {
  const label = {
    updated: "Updated active copy",
    unchanged: "Unchanged",
    "local-kept": "Local edits kept active",
    "native-delete": "Native deletion kept",
    pending: "Fresh review needed",
  }[outcome.status];
  return `${terminalData(outcome.name)} · ${label} · ${terminalData(outcome.path)}${outcome.reason ? ` · ${terminalData(outcome.reason)}` : ""}`;
}
