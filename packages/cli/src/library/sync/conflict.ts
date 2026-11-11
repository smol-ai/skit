import { SyncConflictDetail } from "@smolai/skit-core/library/sync";
import { schemaFailure } from "../../platform/schema-failure.js";
import { Block } from "../../terminal/blocks.js";

/**
 * What a sync conflict says. An installed copy that changed reads differently as an enablement
 * issue, where sync has already finished, than as a conflict that stopped it.
 */
export const syncConflict = (detail: SyncConflictDetail, shown: "conflict" | "issue"): string =>
  SyncConflictDetail.match(detail, {
    CollectionChanged: ({ label, resolution }) =>
      resolution === "take-remote"
        ? `${label} has incompatible Source records, changed on both devices, or was removed while its content changed.`
        : `${label} has Source records that differ between devices and local content that cannot be discarded safely. Keep the local edit or unpinned Import before syncing; this conflict cannot be taken remotely.`,
    SkillChanged: ({ name }) => `${name} differs between devices.`,
    RecordChanged: () => "Both devices changed the same Library record.",
    LibraryInvalid: ({ failure }) =>
      `${schemaFailure(failure)}. No changes were applied. Fix the named records before syncing.`,
    DestinationCollision: ({ skills, resolution }) =>
      `${skills.map((skill) => `${skill.name} from ${skill.collection}`).join("; ")} use the same destination. ${
        resolution === "keep-enabled"
          ? `Choose one to keep enabled everywhere. ${skills.length === 2 ? "Both" : "All"} stay in the Library.`
          : "Configure distinct skills directories or disable the competing repository selection before syncing."
      }`,
    MissingSkillVersion: ({ name }) =>
      `${name} has no selected Version in the Library. Update it or disable it before syncing.`,
    MissingInstalledSkillVersion: ({ path }) => `No Version in the Library can replace ${path}.`,
    InstalledSkillChanged: ({ path }) =>
      shown === "issue"
        ? `Cannot remove modified Skill at ${path}. Save the edited directory outside the skills directory, then restore the managed copy before retrying.`
        : `Sync would replace or remove ${path}, whose bytes or ownership changed. Save the edited directory outside the skills directory, then restore the managed copy before syncing.`,
    RepositoryEnabledInvalid: ({ root }) =>
      `The repository at ${root} still enables something removed. Disable it there before syncing.`,
  });

/** Keep selectors exact and shell-safe, even when a stored record key contains punctuation. */
const resolutionCommand = (flag: "--take-remote" | "--keep-enabled", selector: string) =>
  `skit sync --apply ${flag} '${selector.replaceAll("'", "'\\''")}'`;

/** One presentation for conflicts returned as a result or raised as a failure. */
function renderSyncConflict(detail: SyncConflictDetail): Block {
  const title = SyncConflictDetail.match(detail, {
    CollectionChanged: ({ label }) => label,
    SkillChanged: ({ name }) => name,
    RecordChanged: () => "Library record",
    LibraryInvalid: () => "Library",
    DestinationCollision: () => "Skills share an install destination",
    MissingSkillVersion: ({ name }) => name,
    MissingInstalledSkillVersion: ({ path }) => path,
    InstalledSkillChanged: ({ path }) => path,
    RepositoryEnabledInvalid: ({ root }) => root,
  });
  const choices: Block[] = [];
  if (
    detail.resolution === "take-remote" &&
    (detail._tag === "CollectionChanged" ||
      detail._tag === "SkillChanged" ||
      detail._tag === "RecordChanged")
  ) {
    choices.push(
      Block.Note({
        text: [
          detail._tag === "CollectionChanged"
            ? "Use the remote Collection, its Imports and Version history, and what it enables everywhere. This replaces this device's choices for the Collection."
            : detail._tag === "SkillChanged"
              ? "Use the remote Skill record instead of this device's record."
              : "Use the remote record instead of this device's record.",
        ],
      }),
      Block.Verbatim({ text: resolutionCommand("--take-remote", detail.key) }),
    );
  } else if (detail._tag === "DestinationCollision" && detail.resolution === "keep-enabled") {
    choices.push(
      ...detail.skills.map((skill) =>
        Block.Group({
          title: `Keep ${skill.name} from ${skill.collection} enabled everywhere`,
          children: [Block.Verbatim({ text: resolutionCommand("--keep-enabled", skill.id) })],
        }),
      ),
    );
  }
  return Block.Group({
    title,
    children: [Block.Note({ text: [syncConflict(detail, "conflict")] }), ...choices],
  });
}

export function renderSyncConflicts(details: readonly SyncConflictDetail[]): Block[] {
  const choices = details.filter((detail) => detail.resolution !== "local");
  return [
    ...details.map(renderSyncConflict),
    ...(choices.length > 1
      ? [
          Block.Note({
            text: [
              "Resolve these conflicts together: combine the chosen resolution flags in one ",
              { code: "skit sync --apply" },
              " command.",
            ],
          }),
        ]
      : []),
  ];
}
