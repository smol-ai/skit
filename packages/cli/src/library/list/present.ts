import { Block, type Field } from "../../terminal/blocks.js";
import { metadataDate, metadataRevision, metadataSource } from "../presentation/skill-metadata.js";
import type { ListResult } from "./output.js";
import {
  collectionTitle,
  collectionEnablement,
  collectionWarnings,
} from "../presentation/collection-source.js";

export function renderLibraryList(data: ListResult): Block[] {
  if (data.subjects.length === 0) return [Block.Note({ text: ["No Skills in this Library."] })];
  const subjects = data.subjects.map((subject) => {
    const source = subject.collection_source;
    const versions = subject.skills.reduce((count, skill) => count + skill.versions.length, 0);
    const unresolved = subject.skills.filter(
      (skill) => skill.selected_skill_version_id === undefined,
    ).length;
    const enabled = subject.enabled_skills ?? data.enabled_skills;
    const facts: Field[] = [
      ...(source === undefined
        ? []
        : source.kind === "authored-workspace"
          ? [
              source.locator
                ? { label: "Source", value: [metadataSource(source.locator)] }
                : { label: "Source", value: [{ dim: "Workspace location unavailable" }] },
              ...(source.authority ? [{ label: "Registry", value: [source.authority] }] : []),
            ]
          : [
              source.kind === "registry"
                ? { label: "Registry", value: [`${source.authority}`] }
                : { label: "Source", value: [metadataSource(source.locator)] },
              ...(source.revision ? [{ label: "Revision", value: [source.revision] }] : []),
            ]),
      { label: "Skills", value: [String(subject.skills.length)] },
      { label: "Skill Versions", value: [String(versions)] },
      ...(unresolved === 0 ? [] : [{ label: "Unresolved", value: [String(unresolved)] }]),
      {
        label: "Status",
        value: [
          collectionEnablement(
            subject.skills.length,
            subject.skills.filter((skill) => enabled.includes(skill.skill_id)).length,
          ),
        ],
      },
      ...(subject.scopes?.length
        ? [
            {
              label: "Enabled at",
              value: [
                subject.scopes
                  .map((scope) => (scope.kind === "global" ? "global" : metadataSource(scope.root)))
                  .join(", "),
              ],
            },
          ]
        : []),
    ];
    const skillFacts = subject.skills.map((skill) => [
      ["Source", skill.source === null ? undefined : metadataSource(skill.source)],
      ["Revision", skill.revision === null ? undefined : metadataRevision(skill.revision)],
      ["Saved", skill.saved_at === undefined ? undefined : metadataDate(skill.saved_at)],
      [
        "Source updated",
        skill.source_updated_at === null ? undefined : metadataDate(skill.source_updated_at),
      ],
      ["Imported", skill.imported_at === null ? undefined : metadataDate(skill.imported_at)],
    ]);
    // Only the facts some Skill has earn a column.
    const shown = (skillFacts[0] ?? []).flatMap(([title], index) =>
      skillFacts.some((row) => row[index]?.[1] !== undefined) ? [{ title, index }] : [],
    );
    return Block.Group({
      title: collectionTitle(subject.label, source),
      children: [
        ...collectionWarnings(source).map((warning) =>
          Block.Status({ tone: "warn", text: [warning] }),
        ),
        Block.Fields({ rows: facts }),
        ...(subject.skills.length
          ? [
              Block.Table({
                columns: [
                  { title: "Skill" },
                  ...shown.map(({ title }) => ({ title: title ?? "" })),
                ],
                rows: subject.skills.map((skill, row) => [
                  [{ emph: skill.name }],
                  ...shown.map(({ index }) => {
                    const value = skillFacts[row]?.[index]?.[1];
                    return value === undefined ? [] : [value];
                  }),
                ]),
              }),
            ]
          : []),
      ],
    });
  });
  const enabled = data.enabled.map((item) => {
    const subject = data.subjects.find((subject) =>
      "collection" in item
        ? subject.subject_id === item.collection
        : subject.skills.some((skill) => skill.skill_id === item.skill),
    );
    const identity =
      subject === undefined ? undefined : collectionTitle(subject.label, subject.collection_source);
    return "collection" in item
      ? `${identity ?? item.label} (whole Collection)`
      : `${item.name}${identity === undefined ? "" : ` (${identity})`}`;
  });
  return [
    ...subjects,
    ...(enabled.length
      ? [Block.Fields({ rows: [{ label: "Enabled", value: [enabled.join(", ")] }] })]
      : []),
  ];
}
