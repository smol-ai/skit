import type { LibraryInventory } from "@smolai/skit-core/library/inventory";
import { metadataDate } from "../presentation/skill-metadata.js";
import { harnessOrigin } from "../presentation/harness-origin.js";
import { basename, dirname, sep } from "node:path";
import { harnessLabel } from "@smolai/skit-core/harnesses";
import { conditionHeadline } from "../presentation/language.js";
import { Block, type Field } from "../../terminal/blocks.js";
import type { MachineInventoryResult } from "./output.js";
import { errorMessage } from "@smolai/skit-core/shared";
import { treeFailure } from "../../platform/tree-failure.js";

type MachineInstance = MachineInventoryResult["machine"]["instances"][number];

/** A label/value fact as plain text, so identical facts compare equal. */
type Fact = { readonly label: string; readonly value: string };

const ownerFacts = (owner: MachineInstance["owner"]): readonly Fact[] => {
  switch (owner.kind) {
    case "pnpm":
      return [
        { label: "Managed by", value: "pnpm, left in place" },
        { label: "Package", value: `${owner.package}@${owner.version}` },
      ];
    case "skills-sh":
      return [
        { label: "Installed by", value: "skills.sh" },
        { label: "Source", value: owner.source },
      ];
    case "skit":
      return owner.membership.kind === "in-library"
        ? [
            { label: "Collection", value: owner.membership.displayName },
            ...(owner.membership.source
              ? [{ label: "Source", value: owner.membership.source }]
              : []),
          ]
        : [
            {
              label: "Collection",
              value: `not in this Library (${owner.membership.collectionId})`,
            },
          ];
    case "harness":
      return [
        {
          label: "Installed by",
          value: `${harnessLabel(owner.harness)}${owner.origin === "system" || owner.origin === "bundled-plugin" ? " (bundled)" : ""}`,
        },
        { label: "Source", value: harnessOrigin(owner) },
      ];
    case "repository":
      return [{ label: "Installed by", value: "repository" }];
    case "authored":
      return [{ label: "Authored Collection", value: owner.skitLocator }];
    case "invalid-marker":
      return [{ label: "Installed by", value: "invalid SKIT ownership marker" }];
    case "unknown":
      return [{ label: "Installed by", value: "unknown" }];
  }
};

const ownerLabel = (owner: MachineInstance["owner"]): string => {
  switch (owner.kind) {
    case "pnpm":
      return "Managed by pnpm";
    case "skit":
      return "Managed by SKIT";
    case "invalid-marker":
      return "Invalid SKIT ownership marker";
    case "authored":
    case "skills-sh":
    case "harness":
    case "repository":
    case "unknown":
      return "Not managed by SKIT";
  }
};

const gitLabel = (
  status: MachineInventoryResult["machine"]["instances"][number]["git"]["status"],
): string => {
  switch (status) {
    case "committed":
      return "Tracked and clean";
    case "modified":
      return "Tracked with local changes";
    case "staged":
      return "Changes staged";
    case "untracked":
      return "Not tracked";
    case "ignored":
      return "Ignored by Git";
    case "mixed":
      return "Mixed Git state";
    case "outside-git":
      return "Outside Git";
    case "unavailable":
      return "Git state unavailable";
  }
};

const libraryRelationshipLabel = (identity: MachineInstance["contentIdentity"]): string => {
  if (identity.status === "failed") return "could not compare";
  if (identity.libraryMatches.length === 0) return "no match";
  return identity.libraryMatches.length > 1 ? "ambiguous match" : "exact match";
};

const displayPath = (path: string, repository?: string): string =>
  repository !== undefined && path.startsWith(`${repository}${sep}`)
    ? path.slice(repository.length + 1)
    : path;

const instancePaths = (instance: MachineInstance, repository?: string): readonly string[] =>
  [...new Set([instance.path, ...instance.aliases])]
    .map((path) => displayPath(path, repository))
    .sort();

const instanceFacts = (instance: MachineInstance, repository?: string): readonly Fact[] => [
  ...ownerFacts(instance.owner),
  { label: "Git", value: gitLabel(instance.git.status) },
  ...(instance.contentIdentity.status === "failed"
    ? [
        {
          label: "Check failed",
          value:
            instance.contentIdentity.failure._tag === "TreeError"
              ? treeFailure(instance.contentIdentity.failure.reason)
              : errorMessage(instance.contentIdentity.failure),
        },
      ]
    : []),
  ...(instance.owner.kind === "skit" &&
  instance.contentIdentity.status === "hashed" &&
  instance.contentIdentity.libraryMatches.length === 1
    ? []
    : [{ label: "Library bytes", value: libraryRelationshipLabel(instance.contentIdentity) }]),
  ...instance.locks
    .map((lock) => ({
      label: "Lock",
      value: `${displayPath(lock.lockPath, repository)} (${lock.content})`,
    }))
    .sort((left, right) => left.value.localeCompare(right.value)),
];

const skillCountLabel = (count: number): string => `${count} Skill${count === 1 ? "" : "s"}`;

const explicitCollectionKey = (instance: MachineInstance): string | undefined => {
  switch (instance.owner.kind) {
    case "skit":
      return `skit:${instance.owner.membership.collectionId}`;
    case "authored":
      return `authored:${instance.owner.collectionId ?? instance.owner.skitLocator}`;
    case "skills-sh":
      return `skills-sh:${instance.owner.source}`;
    case "invalid-marker":
    case "harness":
    case "repository":
    case "unknown":
      return undefined;
  }
};

const pathPattern = (path: string, skillName: string): string =>
  basename(path) === skillName ? `${dirname(path)}${sep}<skill>` : path;

const count = (value: number, word: string) => `${value} ${word}${value === 1 ? "" : "s"}`;

/** Only the Skill count when each Skill has one instance, else both counts. */
const counts = (skills: number, instances: number) =>
  `${count(skills, "Skill")}${instances === skills ? "" : `, ${count(instances, "instance")}`}`;

export function renderMachineSkills(machine: MachineInventoryResult["machine"]): Block[] {
  const names = new Set(machine.instances.map((instance) => instance.name));
  const locations = new Map<string, typeof machine.instances>();
  for (const instance of machine.instances) {
    const location = instance.git.repository ?? "Global and standalone";
    locations.set(location, [...(locations.get(location) ?? []), instance]);
  }
  const groups = [...locations].map(([location, instances]) => {
    const repository = location === "Global and standalone" ? undefined : location;
    const scopes = new Set(instances.map((instance) => instance.scope));
    const locationLabel =
      location !== "Global and standalone"
        ? location
        : scopes.size === 1 && scopes.has("global")
          ? "Global"
          : scopes.size === 1 && scopes.has("standalone")
            ? "Standalone"
            : location;
    const ownershipGroups = new Map<string, typeof instances>();
    for (const instance of instances) {
      const ownership = ownerLabel(instance.owner);
      ownershipGroups.set(ownership, [...(ownershipGroups.get(ownership) ?? []), instance]);
    }
    const ownerships = [...ownershipGroups].map(([ownership, ownershipInstances]) => {
      const bySkill = new Map<string, { name: string; instances: typeof ownershipInstances }>();
      for (const instance of ownershipInstances) {
        const key = `${explicitCollectionKey(instance) ?? "standalone"}\0${instance.name}`;
        const skill = bySkill.get(key) ?? { name: instance.name, instances: [] };
        bySkill.set(key, { ...skill, instances: [...skill.instances, instance] });
      }
      const cohorts = new Map<
        string,
        { names: string[]; facts: readonly Fact[]; instances: MachineInstance[] }
      >();
      for (const { name, instances: skillInstances } of bySkill.values()) {
        const collectionKeys = [
          ...new Set(
            skillInstances
              .map(explicitCollectionKey)
              .filter((reference): reference is string => reference !== undefined),
          ),
        ];
        // Instances that say the same thing share one list of facts.
        const facts = [
          ...new Map(
            skillInstances
              .flatMap((instance) => instanceFacts(instance, repository))
              .map((fact): [string, Fact] => [`${fact.label}: ${fact.value}`, fact]),
          ),
        ]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([, fact]) => fact);
        const patterns = [
          ...new Set(
            skillInstances.flatMap((instance) =>
              instancePaths(instance, repository).map((path) => pathPattern(path, name)),
            ),
          ),
        ].sort();
        const collectionKey = collectionKeys.length === 1 ? collectionKeys[0] : `skill:${name}`;
        const key = JSON.stringify([collectionKey, facts, patterns]);
        const cohort = cohorts.get(key) ?? { names: [], facts, instances: [] };
        cohort.names.push(name);
        cohort.instances.push(...skillInstances);
        cohorts.set(key, cohort);
      }
      return Block.Group({
        title: `${ownership} (${counts(bySkill.size, ownershipInstances.length)})`,
        children: [...cohorts.values()]
          .sort((left, right) => left.names[0]!.localeCompare(right.names[0]!))
          .map((cohort) =>
            Block.Group({
              title: skillCountLabel(cohort.names.length),
              children: [
                Block.Fields({
                  rows: cohort.facts.map(({ label, value }): Field => ({ label, value: [value] })),
                }),
                Block.Table({
                  columns: [{ title: "Skill" }, { title: "Path" }, { title: "SKILL.md modified" }],
                  rows: cohort.names.sort().flatMap((name) =>
                    cohort.instances
                      .filter((instance) => instance.name === name)
                      .flatMap((instance) =>
                        instancePaths(instance, repository).map((path) => ({ instance, path })),
                      )
                      .map(({ instance, path }, index) => [
                        index === 0 ? [{ emph: name }] : [],
                        [
                          path,
                          ...(path === displayPath(instance.path, repository)
                            ? []
                            : [{ dim: " (alias)" }]),
                        ],
                        [metadataDate(instance.skill_md_modified_at)],
                      ]),
                  ),
                }),
              ],
            }),
          ),
      });
    });
    return Block.Group({
      title: `${locationLabel} (${counts(new Set(instances.map((instance) => instance.name)).size, instances.length)})`,
      children: ownerships,
    });
  });
  return [
    Block.Heading({ text: "Inventory" }),
    Block.Fields({
      rows: [
        { label: "Skills", value: [String(names.size)] },
        { label: "Instances", value: [String(machine.instances.length)] },
      ],
    }),
    ...(machine.instances.length ? groups : [Block.Note({ text: ["No Skill instances found."] })]),
  ];
}

const scanScope = (machine: MachineInventoryResult["machine"]): Block => {
  const ignored = machine.repositoryDecisions.filter(
    (repository) => repository.status === "ignored",
  );
  return Block.Group({
    title: "Scan scope",
    children: [
      Block.Fields({
        rows: [
          { label: "Status", value: [machine.scan.complete ? "complete" : "incomplete"] },
          { label: "Directories examined", value: [String(machine.scan.directoriesExamined)] },
          { label: "Repository depth", value: [String(machine.scan.repositorySearchDepth)] },
          {
            label: "Repository roots",
            value: machine.repositoryRoots.length
              ? [machine.repositoryRoots.join("\n")]
              : [{ dim: "none configured" }],
          },
          ...(ignored.length
            ? [
                {
                  label: "Ignored repositories",
                  value: [ignored.map((repository) => repository.path).join("\n")],
                },
              ]
            : []),
          ...(machine.scan.missingRepositories?.length
            ? [
                {
                  label: "Missing watched repositories",
                  value: [machine.scan.missingRepositories.join("\n")],
                },
              ]
            : []),
        ],
      }),
    ],
  });
};

const inventoryFindings = (state: LibraryInventory): Block[] => [
  ...(state.ownershipIssues?.length
    ? [
        Block.Group({
          title: `Ownership issues (${state.ownershipIssues.length})`,
          children: [
            Block.List({
              items: state.ownershipIssues.map((issue) => ({
                text: [conditionHeadline(issue.code, "Local ownership issue")],
                detail: [{ dim: issue.path }],
              })),
            }),
            Block.Note({ text: ["Run ", { code: "skit doctor" }, " for details."] }),
          ],
        }),
      ]
    : []),
  ...(state.scanIssues?.length
    ? [
        Block.Group({
          title: `Scan issues (${state.scanIssues.length})`,
          children: state.scanIssues.map((issue) =>
            issue.code === "DANGLING_SYMLINK"
              ? Block.Group({
                  title: "Dangling link",
                  children: [
                    Block.Fields({
                      rows: [
                        { label: "Harness", value: [harnessLabel(issue.harness)] },
                        { label: "Link", value: [issue.path] },
                        { label: "Missing target", value: [issue.target] },
                      ],
                    }),
                  ],
                })
              : Block.Group({
                  title: issue.code === "MISSING_ROOT" ? "Missing root" : "Unreadable root",
                  children: [
                    Block.Fields({
                      rows: [
                        { label: "Harness", value: [harnessLabel(issue.harness)] },
                        { label: "Path", value: [issue.path] },
                      ],
                    }),
                  ],
                }),
          ),
        }),
      ]
    : []),
];

export function renderInventory(state: MachineInventoryResult): Block[] {
  // Installed copies SKIT manages, counted once per path.
  const managed = new Set(
    state.installed_skills
      .filter((installed) => state.skills.some((skill) => skill.skill_id === installed.skill_id))
      .map((installed) => installed.path),
  );
  return [
    ...renderMachineSkills(state.machine),
    Block.Group({
      title: "Installed skills",
      children: [
        Block.Fields({
          rows: [
            { label: "Managed", value: [String(managed.size)] },
            { label: "Unmanaged", value: [String(state.unmanaged.length)] },
          ],
        }),
      ],
    }),
    ...inventoryFindings(state),
    scanScope(state.machine),
  ];
}
