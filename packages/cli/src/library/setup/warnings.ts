import { SetupWarning, SetupWarningReason } from "@smolai/skit-core/library/setup";
import { applyFailure } from "../apply-failure.js";

export const setupWarning = ({ name, reason }: SetupWarning): string =>
  SetupWarningReason.match(reason, {
    ApplicationIncomplete: ({ failure }) => applyFailure(failure).message,
    ReplacementMissing: ({ path }) =>
      `Enabled ${name}; existing copies were left in place because the replacement at ${path} is not installed. Run skit doctor to inspect the conflict.`,
    ReplacementChanged: ({ path }) =>
      `Enabled ${name}; existing copies remain because the replacement at ${path} changed before it could be backed up.`,
    ReplacementUnreadable: () =>
      `Enabled ${name}; existing copies were left in place because no active replacement is readable by their harness. Run skit doctor to inspect the conflict.`,
  });
