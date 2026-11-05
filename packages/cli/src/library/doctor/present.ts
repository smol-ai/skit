import { renderDoctorListingBudget } from "./budget.js";
import type { DoctorReport } from "./harnesses.js";
import { dirname } from "node:path";
import { compactHomePath } from "../../terminal/home-path.js";
import { harnessLabel } from "@smolai/skit-core/harnesses";
import { conditionHeadline, conditionNextStep } from "../presentation/language.js";
import { createColors } from "picocolors";
import type { RenderContext } from "../../terminal/contracts.js";

export function renderDoctor(data: typeof DoctorReport.Type, context: RenderContext): string {
  const color = createColors(context.color);
  const section = (title: string) => color.cyan(color.bold(title));
  const path = (value: string) => color.cyan(compactHomePath(value));
  const lines = [section("SKIT doctor"), color.dim(compactHomePath(data.codex.cwd)), ""];
  lines.push(
    data.ok
      ? `${color.green("✓")} ${color.bold("Local library is healthy")}`
      : `${color.red("✕")} ${color.bold(`${data.issues.length} library issue${data.issues.length === 1 ? "" : "s"}`)}`,
  );

  const findings: string[] = [];
  let hasCollisions = data.codex.findings.some((finding) => finding.kind !== "layered-name");
  for (const issue of data.issues) {
    findings.push(
      `  ${color.red("✕")} ${conditionHeadline(issue.code, "Local library issue")}${issue.target ? color.dim(` · .${issue.target}`) : ""}`,
    );
    if (issue.path) findings.push(`      ${path(issue.path)}`);
    else if (issue.skillId) findings.push(`      ${color.dim(issue.skillId)}`);
    const next = conditionNextStep(issue.code);
    if (next) findings.push(`      ${color.dim(`Next: ${next}`)}`);
  }
  for (const finding of data.codex.findings) {
    findings.push(
      `  ${color.yellow("!")} ${color.bold(finding.name)} ${color.dim(`· Codex · ${finding.instances.length} entries`)}`,
      `      ${finding.kind === "layered-name" ? "Same skill name at different scopes (layered)" : finding.kind === "duplicate-name" ? "Same skill name" : "Different skill names share this display name"} · ${finding.documents === "identical" ? "identical SKILL.md" : finding.documents === "different" ? "different SKILL.md" : "content comparison unavailable"}`,
      ...finding.instances.flatMap((instance) => {
        const locations: readonly import("@smolai/skit-core/library/routing").SkillAlias[] =
          instance.aliases?.length
            ? instance.aliases
            : [{ path: instance.path, via: "unknown-root" }];
        return locations.map(
          (alias) =>
            `      ${path(alias.path)}${alias.via === "symlink" ? ` → ${path(dirname(instance.canonicalPath))} ${color.dim(`(symlink${alias.linkPath && alias.linkPath !== alias.path ? ` at ${compactHomePath(alias.linkPath)}` : ""})`)}` : color.dim(` (${alias.via})`)} ${color.dim(`· ${instance.scope}${instance.pluginId ? ` · plugin ${instance.pluginId}` : ""} · ${instance.skitManaged ? "SKIT projection" : "not tracked by SKIT"}`)}`,
        );
      }),
      ...(finding.kind !== "layered-name" &&
      finding.instances.some((instance) =>
        instance.aliases?.some((alias) => alias.via === "symlink"),
      )
        ? [
            "      Remove the redundant symlink alias or disable the SKIT Binding; preserve the source directory.",
          ]
        : []),
    );
  }
  for (const error of data.codex.errors)
    findings.push(
      `  ${color.yellow("!")} Codex could not inspect ${path(error.path)}`,
      `      ${error.message}`,
    );

  for (const check of data.harnesses) {
    for (const skill of check.skills) {
      for (const error of skill.errors)
        findings.push(
          `  ${color.yellow("!")} ${harnessLabel(check.harness)} · ${color.bold(skill.name)}`,
          `      ${error}`,
          ...(skill.path ? [`      ${path(skill.path)}`] : []),
        );
      for (const warning of skill.warnings)
        findings.push(
          `  ${color.yellow("!")} ${harnessLabel(check.harness)} · ${color.bold(skill.name)}`,
          `      ${warning}`,
          ...(skill.path ? [`      ${path(skill.path)}`] : []),
        );
    }
    const collisions = check.findings.filter((finding) => finding._tag === "NameCollision");
    if (collisions.length) hasCollisions = true;
    for (const { name, paths, selectedPath } of collisions) {
      findings.push(
        `  ${color.yellow("!")} ${color.bold(name)} ${color.dim(`· OpenCode · ${paths.length} locations`)}`,
        "      Same skill name · OpenCode selects one copy",
      );
      findings.push(
        ...[...paths].sort().map((value) => {
          const location = check.locations?.find(
            (item) =>
              item.canonicalPath === dirname(value) ||
              item.aliases.some((alias) => alias.path === dirname(value)),
          );
          const aliases = location?.aliases.filter((alias) => alias.via === "symlink") ?? [];
          return `      ${path(value)}${value === selectedPath ? color.dim(" · selected") : ""}${aliases.length ? `\n${aliases.map((alias) => `      ${path(alias.path)} → ${path(location?.canonicalPath ?? dirname(value))} ${color.dim("(symlink)")}`).join("\n")}` : ""}`;
        }),
      );
    }
    findings.push(
      ...check.findings
        .filter((finding) => finding._tag === "Warning")
        .map(
          (warning) => `  ${color.yellow("!")} ${harnessLabel(check.harness)} · ${warning.message}`,
        ),
    );
  }
  if (findings.length) lines.push("", section("Needs attention"), ...findings);

  lines.push("", section("Skill budgets"));
  for (const budget of data.listing_budgets)
    lines.push(...renderDoctorListingBudget(budget, context));

  lines.push("", section("Harness discovery"));
  const status = (state: string, warning: boolean) =>
    state === "checked"
      ? warning
        ? color.yellow("!")
        : color.green("✓")
      : state === "missing"
        ? color.dim("–")
        : color.yellow("!");
  const codex = data.codex;
  lines.push(
    `  ${status(codex.status, Boolean(codex.findings.some((finding) => finding.kind !== "layered-name") || codex.errors.length))} ${"Codex".padEnd(14)} ${codex.status === "checked" ? `${codex.instances.length} enabled skill${codex.instances.length === 1 ? "" : "s"}` : codex.status === "missing" ? "not installed" : "not checked"}${codex.version ? color.dim(` · ${codex.version}`) : ""}`,
  );
  if (codex.status !== "checked" && codex.status !== "missing")
    lines.push(`      ${color.dim(codex.detail ?? codex.status)}`);
  if (context.detail === "full")
    lines.push(
      ...codex.instances.map((instance) => `      ${instance.name} · ${path(instance.path)}`),
    );
  for (const check of data.harnesses) {
    const warning = Boolean(
      check.warnings.length ||
      check.skills.some((skill) => skill.warnings.length || skill.errors.length),
    );
    lines.push(
      `  ${status(check.status, warning)} ${harnessLabel(check.harness).padEnd(14)} ${check.status === "checked" ? `${check.skills.length} ${check.coverage === "callable-commands" ? `callable command${check.skills.length === 1 ? "" : "s"}` : `skill${check.skills.length === 1 ? "" : "s"}`}` : check.status === "missing" ? "not installed" : "not checked"}${check.version ? color.dim(` · ${check.version}`) : ""}`,
    );
    if (check.status === "checked") {
      if (context.detail === "full")
        lines.push(
          ...check.skills.map(
            (skill) =>
              `      ${skill.name}${skill.id && skill.id !== skill.name ? ` · ID: ${skill.id}` : ""}${skill.path ? ` · ${path(skill.path)}` : ""}`,
          ),
        );
    } else if (check.status !== "missing")
      lines.push(`      ${color.dim(check.detail ?? check.status)}`);
  }

  lines.push("", section("Next steps"));
  if (hasCollisions)
    lines.push(
      "  Inspect the listed copies and their ownership before disabling or removing one.",
      `  ${color.cyan("skit inventory")} ${color.dim("· inspect discovered copies and ownership")}`,
    );
  else if (data.issues.length)
    lines.push(
      `  ${color.cyan("skit inventory")} ${color.dim("· inspect affected paths and ownership")}`,
    );
  lines.push(
    `  ${color.cyan("skit doctor --json")} ${color.dim("· full lists, paths and native diagnostics")}`,
  );
  return lines.join("\n");
}
