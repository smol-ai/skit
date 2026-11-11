import type { InstalledSkillChange } from "@smolai/skit-core/library/setup";
import { InstalledSkillChangeReason } from "@smolai/skit-core/library";
import { installedSkillInvalidReason } from "../installed-skill-failures.js";
import { dataFailure } from "../../commands/data-failure.js";
import { errorMessage } from "@smolai/skit-core/shared";

export const installedSkillChangeReason = (reason: InstalledSkillChangeReason): string =>
  InstalledSkillChangeReason.match(reason, {
    Unmanaged: () => "The folder holds what SKIT did not write",
    Protected: ({ owner }) =>
      ({
        repository: "A repository owns this folder",
        authored: "An author's workspace owns this folder",
        "package-manager": "A package manager owns this folder",
      })[owner],
    Unreadable: ({ reason }) =>
      `The folder cannot be read as a skill: ${installedSkillInvalidReason(reason)}`,
    Modified: ({ path }) => `Refusing to remove modified Skill at ${path}`,
    NativeDelete: () => "The user deleted this folder; it stays deleted",
    SourceVersionChanged: () =>
      "The source import changed the desired Version. Use skit update to review managed copies; setup leaves them untouched.",
    PlanningFailed: ({ error }) =>
      `The Library cannot plan its installed copies: ${dataFailure(error)?.message ?? errorMessage(error)}`,
  });

/** Setup reports managed copies without offering to change them. */
export function installedSkillChangeLabel(fact: InstalledSkillChange) {
  if (fact.metadataChanged) return "Installed metadata differs";
  switch (fact.status) {
    case "unchanged":
      return "Matches Library";
    case "incoming-update":
      return "Library version changed";
    case "local-only":
      return "Installed copy has local edits";
    case "competing":
      return "Installed copy and Library both changed";
    case "protected":
      return "Folder needs attention";
    case "native-delete":
      return "Folder was deleted";
    case "uninstall":
      return "No longer enabled here";
    case "install":
      return "Enabled copy is missing";
  }
}
