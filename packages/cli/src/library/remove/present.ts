import { Block, type Change } from "../../terminal/blocks.js";
import type { RemovePlan, RemoveResult } from "./output.js";
import { collectionIdentity } from "../presentation/collection-source.js";

export function renderRemovePlan(data: RemovePlan): Block[] {
  const enabledScopes = data.global_enabled + data.repositories;
  return [
    ...(data.collection_label === undefined
      ? []
      : collectionIdentity(data.collection_label, data.collection_source)),
    Block.Changes({
      items: [
        {
          action: "remove",
          label: `Would remove ${data.skills} ${data.skills === 1 ? "skill" : "skills"} from your library.`,
        },
        ...(enabledScopes
          ? [
              {
                action: "remove",
                label: `Would also disable ${data.subject_kind === "collection" ? "this collection" : "this skill"} at ${enabledScopes} ${enabledScopes === 1 ? "scope" : "scopes"}.`,
              } satisfies Change,
            ]
          : []),
        ...(data.installed_skills
          ? [
              {
                action: "remove",
                label: `Would also uninstall ${data.installed_skills} ${data.installed_skills === 1 ? "skill folder" : "skill folders"}.`,
              } satisfies Change,
            ]
          : []),
      ],
    }),
    ...(data.collection_source?.kind === "authored-workspace"
      ? [
          Block.Note({
            text: [
              "Removes the Library registration and installed copies. Authored files and the Registry connection remain in the workspace.",
            ],
          }),
        ]
      : []),
    ...(data.collection_source?.kind === "registry"
      ? [
          Block.Note({
            text: [
              "Removes this release from the Library; the published release stays in the Registry.",
            ],
          }),
        ]
      : []),
  ];
}

export function renderRemove(data: RemoveResult): Block[] {
  return [
    ...(data.collection_label === undefined
      ? []
      : collectionIdentity(data.collection_label, data.collection_source)),
    Block.Status({
      tone: "ok",
      text: [`Removed ${data.skills} ${data.skills === 1 ? "skill" : "skills"} from your library.`],
    }),
    ...(data.uninstalled
      ? [
          Block.Status({
            tone: "ok",
            text: [
              `Uninstalled ${data.uninstalled} ${data.uninstalled === 1 ? "skill folder" : "skill folders"}.`,
            ],
          }),
        ]
      : []),
    ...(data.collection_source?.kind === "authored-workspace"
      ? [
          Block.Note({
            text: ["Authored files and the Registry connection remain in the workspace."],
          }),
        ]
      : []),
    ...(data.collection_source?.kind === "registry"
      ? [Block.Note({ text: ["The published release remains in the Registry."] })]
      : []),
  ];
}
