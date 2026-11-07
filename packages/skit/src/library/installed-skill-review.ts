import { basename, resolve } from "node:path";
import { hashParts } from "../artifact/descriptor.js";
import type * as InstalledSkills from "./installed-skills.js";
import type { Plan } from "./library-plan.js";

const protection: Record<InstalledSkills.Protection, string> = {
  repository: "A repository owns this folder",
  authored: "An author's workspace owns this folder",
  "package-manager": "A package manager owns this folder",
};

/**
 * What setup reviews of every Installed Skill change in a plan, keyed by its path: the folder's
 * hash against the Library's record and against what SKIT would write, and whether that is SKIT's
 * update, the user's edit, or both. Changes nothing.
 */
export const reviewInstalledSkillChanges = (plan: Plan) =>
  plan.changes
    .flatMap((change) => ("subject_id" in change ? [] : [change]))
    .map((change) => {
      const recorded = change.recorded;
      const { skillId, path, destination, skillVersionId } =
        "skillVersionId" in change
          ? change
          : {
              skillId: change.recorded.skill_id,
              path: change.recorded.path,
              destination: change.recorded.destination,
              skillVersionId: change.recorded.skill_version_id,
            };
      const folders = plan.folders.filter((folder) => folder.path === resolve(path));
      const current = folders.flatMap((folder) =>
        folder.entry._tag === "Present" && typeof folder.entry.facts?.hash === "string"
          ? [folder.entry.facts.hash]
          : [],
      )[0];
      const hash = "hash" in change ? change.hash : undefined;
      const fact = {
        ...(recorded === undefined
          ? {}
          : {
              installedSkillId: recorded.installed_skill_id,
              baselineHash: recorded.expected_hash,
            }),
        skillId,
        name: plan.next.skills.find((skill) => skill.skill_id === skillId)?.name ?? basename(path),
        path,
        destination,
        ...(current === undefined ? {} : { currentHash: current }),
        ...(hash === undefined ? {} : { desiredHash: hash }),
        ...(change._tag === "Uninstall" || change._tag === "Forget" || change._tag === "Refuse"
          ? {}
          : { desiredVersionId: skillVersionId }),
        evidence: hashParts(folders.map((folder) => folder.evidence)),
        metadataChanged: false,
      };
      const kept = (reason: string) => ({ ...fact, status: "protected" as const, reason });
      switch (change._tag) {
        case "Unchanged":
          return {
            ...fact,
            status: "unchanged" as const,
            metadataChanged:
              recorded === undefined ||
              recorded.status !== "installed" ||
              recorded.skill_version_id !== change.skillVersionId ||
              recorded.expected_hash !== change.hash,
          };
        case "Manage":
          return { ...fact, status: "unchanged" as const, metadataChanged: true };
        // With a record, SKIT puts back what it moved aside.
        case "Install":
          return {
            ...fact,
            status: recorded === undefined ? ("install" as const) : ("incoming-update" as const),
          };
        case "Update":
          return { ...fact, status: "incoming-update" as const };
        case "Conflict":
          if ("edited" in change) {
            if (!change.edited) return kept("The folder holds what SKIT did not write");
            // The edit already is the selected Version: only the marker changes.
            if (change.currentHash === change.hash)
              return { ...fact, status: "unchanged" as const, metadataChanged: true };
            if (change.hash !== recorded?.expected_hash)
              return { ...fact, status: "competing" as const };
          }
          return { ...fact, status: "local-only" as const };
        case "Protected":
          return kept(protection[change.reason]);
        case "Unreadable":
          return kept(`The folder cannot be read as a skill: ${change.reason}`);
        case "Refuse":
          return kept(change.detail);
        case "KeepDeleted":
          return {
            ...fact,
            status: "native-delete" as const,
            reason: "The user deleted this folder; it stays deleted",
          };
        case "Uninstall":
        case "Forget":
          return { ...fact, status: "uninstall" as const };
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path));
