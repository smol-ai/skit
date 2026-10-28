import type {
  SetEnabledChange,
  SetEnabledResult,
} from "../workflows/library/set-enabled-contract.js";

export function renderSetEnabled(
  data: SetEnabledChange | SetEnabledResult,
  applied: boolean,
): string {
  const application = "application" in data ? data.application : undefined;
  const incomplete = applied && application?.status === "incomplete";
  const verb = incomplete
    ? application.intent === "saved"
      ? "Library choice saved for"
      : "Library choice unchanged for"
    : applied
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
  const change =
    incomplete || data.changed
      ? ""
      : `${data.enabled ? " · Already enabled" : " · Already disabled"}${data.repair ? (applied ? " · Copies repaired" : " · Copies need repair") : ""}`;
  const duplicates = data.shadows ?? [];
  const warning = duplicates.length
    ? `\n${applied ? "Allowed duplicate copies" : "Blocked unless --allow-duplicate"}:\n${duplicates.flatMap((duplicate) => duplicate.aliases.map((alias) => `  ${duplicate.name} (${duplicate.harness}): ${alias.path}${alias.via === "symlink" ? ` → ${duplicate.canonicalPath} (symlink)` : " (directory)"}`)).join("\n")}`
    : "";
  const warnings = data.warnings
    ?.map((warning) => `Could not inspect ${warning.path}: ${warning.message}`)
    .join("\n");
  const notInstalled =
    "projections" in data && data.enabled
      ? data.projections.filter((projection) => projection.status !== "installed")
      : [];
  const notInstalledLines = notInstalled.length
    ? `\nDestinations not recorded installed:\n${notInstalled.map((projection) => `  ${projection.target} · ${projection.status} · ${projection.path}`).join("\n")}`
    : "";
  const unmanaged = applied ? [] : (data.unmanaged_destinations ?? []);
  const unmanagedLines = unmanaged.length
    ? `\nA folder SKIT does not manage is already there; enable manages it only if it is identical, otherwise it is left in place:\n${unmanaged.map((folder) => `  ${folder.target} · ${folder.path}`).join("\n")}`
    : "";
  const completion = incomplete
    ? `\nInstalled copies need attention. ${application.failure?.message ?? "Reconciliation did not complete."}\n${application.failure?.remediation ?? "Inspect the copies, then preview and retry."}\nSaved Library revision: ${application.revision}`
    : "";
  return `${verb} ${skills}${destination}${change}${warning}${unmanagedLines}${notInstalledLines}${warnings ? `\n${warnings}` : ""}${completion}`;
}
