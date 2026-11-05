import { basename } from "node:path";
import { Effect } from "effect";
import { InstalledSkills } from "../../installed-skills.js";
import { installedSkillVariantPath } from "../../../installed-skills/files.js";
import { InstalledSkillInvalid } from "../../installation/install-enabled.js";
import { StalePlan } from "../../library-plan.js";
import type { LibraryState } from "../../library-state.js";
import type { RecordedInstalledChange } from "../../store/state-schema.js";

/** Execute the fixed row and write policy, with no planner, clock, ID allocation or store. */
export const execute = Effect.fn("Library.executeInstalledChange")(function* (
  change: RecordedInstalledChange,
  state: LibraryState,
  folder: InstalledSkills.Folder | undefined,
  originalsPath: string,
  variantsPath: string,
) {
  const files = yield* InstalledSkills.Service;
  switch (change._tag) {
    case "Install": {
      const row = change.row;
      if (!folder)
        return yield* new StalePlan({ message: `Missing recorded folder at ${row.path}` });
      const staged = yield* files.build(
        {
          skillId: row.skill_id,
          skillVersionId: row.skill_version_id,
          destination: row.destination,
          root: row.root,
          invocation: change.invocation,
        },
        state,
        originalsPath,
      );
      if (staged.hash !== row.expected_hash)
        return yield* new StalePlan({ message: `Recorded installed bytes changed at ${row.path}` });
      const marker = {
        schemaVersion: 5 as const,
        installed_skill_id: row.installed_skill_id,
        skill_id: row.skill_id,
        skill_version_id: row.skill_version_id,
        expected_hash: row.expected_hash,
      };
      const installed = yield* change.verification !== "write" && folder.entry._tag !== "Absent"
        ? files.manage(staged, marker, folder, change.verification)
        : files.install(staged, marker, folder);
      if (installed.hash !== row.expected_hash)
        return yield* new StalePlan({ message: `Installed bytes differ at ${row.path}` });
      return;
    }
    case "Save":
      if (change.backUp) {
        if (change.row.status !== "conflicted")
          return yield* new InstalledSkillInvalid({
            detail: "Only a reviewed conflict can be backed up",
          });
        yield* files.backUp(
          change.row.path,
          installedSkillVariantPath(
            variantsPath,
            change.row.destination,
            basename(change.row.path),
            change.row.current_hash,
          ),
        );
      }
      return;
    case "Uninstall": {
      const row = state.installed_skills.find((row) => row.installed_skill_id === change.id);
      if (!row) return yield* new StalePlan({ message: `Missing installed row ${change.id}` });
      yield* files.uninstall(row.root, row.path, row.installed_skill_id);
      return;
    }
    case "Forget":
      return;
    case "Fail":
      return yield* new InstalledSkillInvalid({ detail: change.reason });
  }
});
