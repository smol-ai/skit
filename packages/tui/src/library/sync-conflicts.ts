import { SyncConflictDetail } from "@smolai/skit-core/library/sync";
import { schemaFailure } from "./schema-failure";

/** The TUI describes sync facts without prescribing CLI flags. */
export const syncConflict = (detail: SyncConflictDetail): string =>
  SyncConflictDetail.match(detail, {
    CollectionChanged: ({ label, resolution }) =>
      resolution === "take-remote"
        ? `${label} changed differently on both devices. Choose which Collection to keep, including its Imports, Versions and enabled Skills.`
        : `${label} has different Source records and local content that cannot be discarded safely. Save the local edit before syncing.`,
    SkillChanged: ({ name }) => `${name} differs between devices. Choose which Skill to keep.`,
    RecordChanged: ({ key }) => `Both devices changed ${key}. Choose which record to keep.`,
    LibraryInvalid: ({ failure }) =>
      `${schemaFailure(failure)}. No changes were applied. Fix the named records before syncing.`,
    DestinationCollision: ({ skills, resolution }) =>
      `${skills.map((skill) => `${skill.name} from ${skill.collection} (${skill.id})`).join("; ")} use the same destination. ${resolution === "keep-enabled" ? "Keep one enabled everywhere. Both stay in the Library." : "Choose distinct skills directories or disable the competing repository selection before syncing."}`,
    MissingSkillVersion: ({ name }) =>
      `${name} has no selected Version in the Library. Update it or disable it before syncing.`,
    MissingInstalledSkillVersion: ({ path }) => `No Version in the Library can replace ${path}.`,
    InstalledSkillChanged: ({ path }) =>
      `Sync would replace or remove ${path}, whose files or ownership changed. Save the edited folder outside the skills directory, then restore the managed copy before syncing.`,
    RepositoryEnabledInvalid: ({ root }) =>
      `The repository at ${root} still enables something removed. Disable it there before syncing.`,
  });
