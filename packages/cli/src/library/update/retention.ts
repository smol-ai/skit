import { type ContractData } from "../../commands/output-contracts.js";

export const renderEditImportPlan = (data: ContractData<"projectionRetentionPlan">) =>
  [
    `Would retain changed ${data.skill_name} bytes from ${data.selected_installed_skill_id}`,
    `Observed: ${data.current_hash}`,
    `Snapshot: ${data.snapshot_digest}`,
    `Destination: ${data.original_path}`,
    ...data.installed_skills.map(
      (installedSkill) =>
        `${installedSkill.destination} | ${installedSkill.path} | ${installedSkill.agreement}`,
    ),
  ].join("\n");

export const renderEditImport = (data: ContractData<"projectionRetention">) =>
  [
    data.imported
      ? `Retained ${data.skill_name} as ${data.imported_skill_version_id}`
      : `Reconciled ${data.skill_name} using retained Version ${data.imported_skill_version_id}`,
    `Previous Version: ${data.previous_skill_version_id}`,
    ...data.installed_skills.map(
      (installedSkill) =>
        `${installedSkill.destination} | ${installedSkill.path} | ${installedSkill.status}`,
    ),
  ].join("\n");
