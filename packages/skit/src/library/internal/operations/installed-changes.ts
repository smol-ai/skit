import { basename, resolve } from "node:path";
import { Effect } from "effect";
import { InstalledSkills } from "../../installed-skills.js";
import { installedSkillVariantPath } from "../../../install/files.js";
import type { OwnershipMarker } from "../../../contracts.js";
import type { LibraryState, InstalledSkill } from "../../library-state.js";
import { InstalledSkillInvalid } from "../../installation/install-enabled.js";
import {
  StalePlan,
  type InstalledSkillChange,
  type InstalledSkillResult,
} from "../../library-plan.js";

/**
 * Carry out one change at a folder the next Library installs into, and what the Library records
 * for it. `next` is the Library just planned; `folders` are the folders that plan was decided on.
 */
export const install = Effect.fn("Library.install")(function* (
  change: Exclude<
    Extract<InstalledSkillChange, { readonly skillVersionId: unknown }>,
    { readonly _tag: "Protected" }
  >,
  next: LibraryState,
  folders: readonly InstalledSkills.Folder[],
  expected: InstalledSkill,
  originalsPath: string,
  variantsPath: string,
) {
  const files = yield* InstalledSkills.Service;
  if (change._tag === "KeepDeleted")
    return { _tag: "Suppressed", copy: expected } satisfies InstalledSkillResult;
  if (change._tag === "Unreadable")
    return yield* new InstalledSkillInvalid({ detail: change.reason });
  switch (change._tag) {
    case "Unchanged": {
      const copy = expected;
      return { _tag: "Unchanged", copy } satisfies InstalledSkillResult;
    }
    case "Conflict": {
      if (change.edited)
        yield* files.backUp(
          change.path,
          installedSkillVariantPath(
            variantsPath,
            change.destination,
            basename(change.path),
            change.currentHash,
          ),
        );
      const copy = expected;
      return { _tag: "Conflicted", copy } satisfies InstalledSkillResult;
    }
    case "Manage":
    case "Update":
    case "Install": {
      // A folder that was not there is built only now, once its root exists; apply created the
      // root since plan read the folder, so nothing may have appeared there.
      const staged = yield* files.build(change, next, originalsPath);
      const [folder] =
        change._tag === "Install"
          ? [yield* files.inspect(change.path)]
          : folders.filter((item) => item.path === resolve(change.path));
      if (
        folder === undefined ||
        (change._tag === "Install" ? folder.entry._tag !== "Absent" : staged.hash !== change.hash)
      )
        return yield* new StalePlan({
          message: `Installed skill evidence changed at ${change.path}`,
        });
      if (staged.hash !== expected.expected_hash)
        return yield* new StalePlan({
          message: `Recorded installed bytes changed at ${change.path}`,
        });
      const marker: OwnershipMarker = {
        schemaVersion: 5,
        installed_skill_id: expected.installed_skill_id,
        skill_id: change.skillId,
        skill_version_id: change.skillVersionId,
        expected_hash: staged.hash,
      };
      const installed = yield* change._tag === "Manage"
        ? files.manage(staged, marker, folder, change.verification)
        : files.install(staged, marker, folder);
      if (staged.hash !== expected.expected_hash || installed.hash !== expected.expected_hash)
        return yield* new StalePlan({
          message: `Recorded installed bytes changed at ${change.path}`,
        });
      const copy = expected;
      return { _tag: "Installed", copy } satisfies InstalledSkillResult;
    }
  }
});
