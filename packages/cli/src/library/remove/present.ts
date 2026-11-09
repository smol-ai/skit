import type { RemovePlan, RemoveResult } from "./output.js";
import { collectionTitle, collectionDetails } from "../presentation/collection-source.js";

export function renderRemovePlan(data: RemovePlan) {
  const enabledScopes = data.global_enabled + data.repositories;
  return [
    ...(data.collection_label === undefined
      ? []
      : [
          collectionTitle(data.collection_label, data.collection_source),
          ...collectionDetails(data.collection_source),
        ]),
    `Would remove ${data.skills} ${data.skills === 1 ? "skill" : "skills"} from your library.`,
    ...(enabledScopes
      ? [`Would also remove ${enabledScopes} ${enabledScopes === 1 ? "binding" : "bindings"}.`]
      : []),
    ...(data.installed_skills
      ? [
          `Would also retire ${data.installed_skills} ${data.installed_skills === 1 ? "installed skill" : "installed skills"}.`,
        ]
      : []),
    ...(data.collection_source?.kind === "authored-workspace"
      ? [
          "Removes the Library registration and installed copies. Authored files and the Registry connection remain in the workspace.",
        ]
      : []),
    ...(data.collection_source?.kind === "registry"
      ? ["Removes this release from the Library; the published release stays in the Registry."]
      : []),
  ].join("\n");
}
export function renderRemove(data: RemoveResult) {
  return [
    ...(data.collection_label === undefined
      ? []
      : [
          collectionTitle(data.collection_label, data.collection_source),
          ...collectionDetails(data.collection_source),
        ]),
    `Removed ${data.skills} ${data.skills === 1 ? "skill" : "skills"} from your library.`,
    ...(data.uninstalled
      ? [
          `Retired ${data.uninstalled} ${data.uninstalled === 1 ? "installed skill" : "installed skills"}.`,
        ]
      : []),
    ...(data.collection_source?.kind === "authored-workspace"
      ? ["Authored files and the Registry connection remain in the workspace."]
      : []),
    ...(data.collection_source?.kind === "registry"
      ? ["The published release remains in the Registry."]
      : []),
  ].join("\n");
}
