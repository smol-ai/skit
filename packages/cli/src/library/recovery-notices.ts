import { LibraryRecoveryNotice } from "@smolai/skit-core/library";
import { Block } from "../terminal/blocks.js";

/** Recovery owns the facts; this executable owns their diagnostic wording. */
export const recoveryNoticeBlocks = (notice: LibraryRecoveryNotice): readonly Block[] => {
  const detail = LibraryRecoveryNotice.match(notice, {
    PendingStateSaveFailed: ({ path }) => ({
      summary: "Installed files changed, but pending state could not be saved",
      rows: path === undefined ? [] : [{ label: "Path", value: [{ path }] }],
    }),
    BackupsStillPending: ({ installedSkillId, path }) => ({
      summary: "Library changed, but installed-skill backups stayed pending",
      rows: [
        { label: "Installed Skill", value: [{ code: installedSkillId }] },
        { label: "Path", value: [{ path }] },
      ],
    }),
    SetupStopNotRecorded: ({ operationId }) => ({
      summary: "Setup stopped, but could not record it",
      rows: [{ label: "Operation", value: [{ code: operationId }] }],
    }),
    HistoryDeliveryPending: ({ actionId }) => ({
      summary: "Library history delivery is pending",
      rows: actionId === undefined ? [] : [{ label: "Action", value: [{ code: actionId }] }],
    }),
  });
  return [
    Block.Note({ text: [detail.summary] }),
    Block.Fields({ rows: [{ label: "Library", value: [{ path: notice.home }] }, ...detail.rows] }),
  ];
};
