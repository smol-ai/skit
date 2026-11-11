import { YamlWarning } from "@smolai/skit-core/universal/consumer";
import { Logger, Schema } from "effect";
import { descriptorIssue } from "./descriptor-issue.js";
import { LibraryRecoveryNotice } from "@smolai/skit-core/library";
import { PnpmEvidenceUnreadable } from "@smolai/skit-core/installed-skills/pnpm-failures";
import { recoveryNoticeBlocks } from "../library/recovery-notices.js";
import { Block, renderBlocks } from "../terminal/blocks.js";

const logValue = (value: unknown): readonly unknown[] => {
  if (Schema.is(YamlWarning)(value))
    return [`YAML warning: ${descriptorIssue({ _tag: "YamlSyntax", errors: [value] })}`];
  if (Schema.is(LibraryRecoveryNotice)(value))
    return [renderBlocks(recoveryNoticeBlocks(value), { color: false }), value.failure];
  if (Schema.is(PnpmEvidenceUnreadable)(value))
    return [
      renderBlocks(
        [
          Block.Note({ text: ["Cannot read pnpm Skill evidence"] }),
          Block.Fields({ rows: [{ label: "Path", value: [{ path: value.path }] }] }),
        ],
        { color: false },
      ),
      value.failure,
    ];
  return [value];
};

/** Owners log facts. This executable supplies words for the warnings it presents. */
export const cliLogger = Logger.make((options) =>
  Logger.defaultLogger.log({
    ...options,
    message: Array.isArray(options.message)
      ? options.message.flatMap(logValue)
      : logValue(options.message),
  }),
);
