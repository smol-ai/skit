import { describeFailure } from "../terminal/failure.js";
import type { DedicatedInstallerRequired } from "@smolai/skit-core/library/source/installer";

export const installerFailure = ({
  displayName,
  command,
  documentationUrl,
}: DedicatedInstallerRequired) =>
  describeFailure({
    summary: [
      `${displayName} publishes harness-specific builds and cannot be added as one portable Skill Collection.`,
    ],
    next: ["Run ", { code: command }, ". Installation guide: ", { url: documentationUrl }],
  });
