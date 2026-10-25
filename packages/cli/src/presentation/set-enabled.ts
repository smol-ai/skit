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
  const notInstalled =
    "projections" in data && data.enabled
      ? data.projections.filter((projection) => projection.status !== "installed")
      : [];
  const notInstalledLines = notInstalled.length
    ? `\nNot installed (a folder SKIT does not manage is already there):\n${notInstalled.map((projection) => `  ${projection.target} · ${projection.status} · ${projection.path}`).join("\n")}`
    : "";
  const unmanaged = applied ? [] : (data.unmanaged_destinations ?? []);
  const unmanagedLines = unmanaged.length
    ? `\nA folder SKIT does not manage is already there; enable adopts it only if it is identical, otherwise it is left in place:\n${unmanaged.map((folder) => `  ${folder.target} · ${folder.path}`).join("\n")}`
    : "";
  return `${verb} ${skills}${destination}${change}${warning}${unmanagedLines}${notInstalledLines}${warnings ? `\n${warnings}` : ""}`;
}
