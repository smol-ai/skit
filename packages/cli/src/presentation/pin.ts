import type { ContractDataForId } from "../commands/output-contracts.js";

export function renderPin(
  data: ContractDataForId<"skit.pin.v4"> | ContractDataForId<"skit.pin.plan.v4">,
  applied: boolean,
) {
  const selection = data.skills
    .map(
      (skill) =>
        `${skill.skill} → ${skill.selected_version_id ?? data.requested_version ?? "requested release"}`,
    )
    .join("\n");
  if (!applied || !("projected" in data))
    return `${data.changed ? "Ready to select" : "Already selected"} ${selection}\n${data.bindings} Binding${data.bindings === 1 ? "" : "s"} will be reconciled.`;
  return `Selected ${selection}\n${data.projected} Binding${data.projected === 1 ? "" : "s"} projected; ${data.deferred} deferred on this device.`;
}
