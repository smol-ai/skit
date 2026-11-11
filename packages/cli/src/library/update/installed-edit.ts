import { type ContractData } from "../../commands/output-contracts.js";
import { Block } from "../../terminal/blocks.js";

export const renderEditImportPlan = (data: ContractData<"installedEditPlan">): Block[] => [
  Block.Changes({
    items: [
      {
        action: "add",
        label: data.import_required
          ? `Would import edits to ${data.skill_name} into the Library.`
          : `Would update ${data.skill_name} using the version already in the Library.`,
      },
    ],
  }),
  ...(data.installed_skills.length
    ? [
        Block.Table({
          columns: [{ title: "Destination" }, { title: "Path" }, { title: "Agreement" }],
          rows: data.installed_skills.map((installedSkill) => [
            [installedSkill.destination],
            [{ dim: installedSkill.path }],
            [installedSkill.agreement],
          ]),
        }),
      ]
    : []),
];

export const renderEditImport = (data: ContractData<"installedEdit">): Block[] => [
  Block.Status({
    tone: "ok",
    text: [
      data.imported
        ? `Imported edits to ${data.skill_name} into the Library.`
        : `Updated ${data.skill_name} using the version already in the Library.`,
    ],
  }),
  ...(data.installed_skills.length
    ? [
        Block.Table({
          columns: [{ title: "Destination" }, { title: "Path" }, { title: "Status" }],
          rows: data.installed_skills.map((installedSkill) => [
            [installedSkill.destination],
            [{ dim: installedSkill.path }],
            [installedSkill.status],
          ]),
        }),
      ]
    : []),
];
