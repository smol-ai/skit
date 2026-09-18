import type { ContractDataForId } from "../commands/output-contracts.js";

export function renderPortableRemovePlan(data: ContractDataForId<"skit.remove.plan.v3">) {
  const bindings = data.global_bindings + data.repository_bindings;
  return `Remove ${data.collection_id}: ${data.versions} retained Version${data.versions === 1 ? "" : "s"}, ${data.owned_projections} owned Projection${data.owned_projections === 1 ? "" : "s"}, ${bindings} Binding${bindings === 1 ? "" : "s"}.`;
}
export function renderPortableRemove(data: ContractDataForId<"skit.remove.v3">) {
  return `Removed ${data.collection_id}; retired ${data.retired} owned Projection${data.retired === 1 ? "" : "s"}.`;
}
