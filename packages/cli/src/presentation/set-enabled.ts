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
  const skills =
    data.skills.length > 3
      ? `${data.skills.length} skills`
      : data.skills.length
        ? data.skills.join(", ")
        : "no skills";
  const destination = data.scope.kind === "global" ? "" : ` in ${data.scope.root}`;
  const change = data.changed
    ? ""
    : `${data.enabled ? " · Already enabled" : " · Already disabled"}${data.repair ? (applied ? " · Copies repaired" : " · Copies need repair") : ""}`;
  const shadows = data.shadows ?? [];
  const warning = shadows.length
    ? `\n${applied ? "Allowed duplicate copies" : "Blocked unless --allow-duplicate"}:\n${shadows.flatMap((shadow) => shadow.aliases.map((alias) => `  ${shadow.name} (${shadow.harness}): ${alias.path}${alias.via === "symlink" ? ` → ${shadow.canonicalPath} (symlink)` : " (directory)"}`)).join("\n")}`
    : "";
  const warnings = data.warnings
    ?.map((warning) => `Could not inspect ${warning.path}: ${warning.message}`)
    .join("\n");
  return `${verb} ${skills}${destination}${change}${warning}${warnings ? `\n${warnings}` : ""}`;
}
