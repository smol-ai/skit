import type {
  SetEnabledPlan,
  SetEnabledResult,
} from "../workflows/library/set-enabled-contract.js";

export function renderSetEnabled(
  data: SetEnabledPlan | SetEnabledResult,
  applied: boolean,
): string {
  const verb = applied
    ? data.enabled
      ? "Enabled"
      : "Disabled"
    : data.enabled
      ? "Would enable"
      : "Would disable";
  const skills = data.skills.length ? data.skills.join(", ") : "no Skills";
  const destination = data.scope.kind === "global" ? "all projects" : data.scope.root;
  const change = data.changed ? "" : data.enabled ? " · Already enabled" : " · Already disabled";
  return `${verb} ${skills} for every agent (${destination})${change}`;
}
