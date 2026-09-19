import type { ContractDataForId } from "../commands/output-contracts.js";

export function renderPortableRemovePlan(data: ContractDataForId<"skit.remove.plan.v3">) {
  const bindings = data.global_bindings + data.repository_bindings;
  return [
    `Would remove ${data.skills} ${data.skills === 1 ? "skill" : "skills"} from your library.`,
    ...(bindings
      ? [`Would also remove ${bindings} ${bindings === 1 ? "binding" : "bindings"}.`]
      : []),
    ...(data.owned_projections
      ? [
          `Would also retire ${data.owned_projections} ${data.owned_projections === 1 ? "projection" : "projections"}.`,
        ]
      : []),
  ].join("\n");
}
export function renderPortableRemove(data: ContractDataForId<"skit.remove.v3">) {
  return [
    `Removed ${data.skills} ${data.skills === 1 ? "skill" : "skills"} from your library.`,
    ...(data.retired
      ? [`Retired ${data.retired} ${data.retired === 1 ? "projection" : "projections"}.`]
      : []),
  ].join("\n");
}
