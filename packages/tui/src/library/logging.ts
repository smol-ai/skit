import { Logger, Schema } from "effect";
import { LibraryRecoveryNotice } from "@smolai/skit-core/library";
import { PnpmEvidenceUnreadable } from "@smolai/skit-core/installed-skills/pnpm-failures";
import { YamlWarning } from "@smolai/skit-core/universal/consumer";
import { descriptorIssue } from "./descriptor-issue";

const logValue = (value: unknown): readonly unknown[] => {
  if (Schema.is(YamlWarning)(value))
    return [`YAML warning: ${descriptorIssue({ _tag: "YamlSyntax", errors: [value] })}`];
  if (Schema.is(PnpmEvidenceUnreadable)(value))
    return [`Cannot read pnpm Skill evidence at ${value.path}`, value.failure];
  if (Schema.is(LibraryRecoveryNotice)(value)) {
    const text = LibraryRecoveryNotice.match(value, {
      PendingStateSaveFailed: ({ home, path }) =>
        `Installed files changed at ${path ?? home}, but pending state could not be saved`,
      BackupsStillPending: ({ home, installedSkillId, path }) =>
        `Library ${home} changed, but backups for ${installedSkillId} at ${path} stayed pending`,
      SetupStopNotRecorded: ({ home, operationId }) =>
        `Setup ${operationId} stopped in ${home}, but could not record it`,
      HistoryDeliveryPending: ({ home, actionId }) =>
        `Library history delivery is pending in ${home}${actionId === undefined ? "" : ` for ${actionId}`}`,
    });
    return [text, value.failure];
  }
  return [value];
};

/** Keep the native logger's level, fiber, date, cause and error objects. */
export const tuiLogger = Logger.make((options) =>
  Logger.defaultLogger.log({
    ...options,
    message: Array.isArray(options.message)
      ? options.message.flatMap(logValue)
      : logValue(options.message),
  }),
);
