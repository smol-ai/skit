import type { DedicatedInstallerRequired } from "@smolai/skit-core/library/source/installer";

export const installerFailure = ({
  displayName,
  command,
  documentationUrl,
}: DedicatedInstallerRequired) => ({
  message: `${displayName} publishes harness-specific builds and cannot be added as one portable Skill Collection.`,
  remediation: `Run \`${command}\`. Installation guide: ${documentationUrl}`,
});
