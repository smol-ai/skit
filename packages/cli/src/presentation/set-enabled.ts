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
  const shadows = data.shadows ?? [];
  const warning = shadows.length
    ? `\n${applied ? "Allowed duplicate copies" : "Blocked unless --allow-duplicate"}:\n${shadows.flatMap((shadow) => shadow.aliases.map((alias) => `  ${shadow.name} (${shadow.harness}): ${alias.path}${alias.via === "symlink" ? ` → ${shadow.canonicalPath} (symlink)` : " (directory)"}`)).join("\n")}`
    : "";
  const warnings = data.warnings
    ?.map((warning) => `Could not inspect ${warning.path}: ${warning.message}`)
    .join("\n");
  return `${verb} ${skills} for every agent (${destination})${change}${warning}${warnings ? `\n${warnings}` : ""}`;
}
