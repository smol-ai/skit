import type { ContractDataForId } from "../commands/output-contracts.js";

export function renderRemovePlan(data: ContractDataForId<"skit.remove.plan.v5">) {
  const enabledScopes = data.global_enabled + data.repositories;
  return [
    `Would remove ${data.skills} ${data.skills === 1 ? "skill" : "skills"} from your library.`,
    ...(enabledScopes
      ? [`Would also remove ${enabledScopes} ${enabledScopes === 1 ? "binding" : "bindings"}.`]
      : []),
    ...(data.installed_skills
      ? [
          `Would also retire ${data.installed_skills} ${data.installed_skills === 1 ? "installed skill" : "installed skills"}.`,
        ]
      : []),
  ].join("\n");
}
export function renderRemove(data: ContractDataForId<"skit.remove.v5">) {
  return [
    `Removed ${data.skills} ${data.skills === 1 ? "skill" : "skills"} from your library.`,
    ...(data.uninstalled
      ? [
          `Retired ${data.uninstalled} ${data.uninstalled === 1 ? "installed skill" : "installed skills"}.`,
        ]
      : []),
  ].join("\n");
}
