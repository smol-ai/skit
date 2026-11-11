import { setupApplyCommandLine } from "./apply-command.js";
import { commandFailure } from "../../commands/failure-classification.js";
import { basename, relative } from "node:path";
import { harnessLabel } from "@smolai/skit-core/harnesses";
import type { InstalledSkillChange } from "@smolai/skit-core/library/setup";
import { type ContractData, type ContractDataForId } from "../../commands/output-contracts.js";
import type { CommandAction } from "../../commands/command-actions.js";
import { Block, type Change, type Field } from "../../terminal/blocks.js";
import {
  installedSkillChangeReason,
  installedSkillChangeLabel,
} from "../presentation/installed-skill-changes.js";
import { setupWarning } from "./warnings.js";
import { setupActionName, setupLeftAloneReason } from "./reasons.js";
import { errorMessage } from "@smolai/skit-core/shared";
import { treeFailure } from "../../platform/tree-failure.js";

type SetupData = ContractDataForId<"skit.setup.v8">;
type SetupInstance = SetupData["instances"][number];

const setupGitStateOrder = [
  "committed",
  "modified",
  "staged",
  "untracked",
  "ignored",
  "mixed",
  "outside-git",
  "unavailable",
] as const;
const setupExpandedSkillLimit = 5;
const installedStatuses = ["current", "modified", "missing"] as const;

/** "2 committed, 1 modified": how many of `items` are in each state, in a fixed order. */
const stateCounts = <T>(
  items: readonly T[],
  states: readonly string[],
  state: (item: T) => string,
) =>
  states
    .flatMap((status) => {
      const count = items.filter((item) => state(item) === status).length;
      return count ? [`${count} ${status}`] : [];
    })
    .join(", ");

/** Each action a person or agent can run next, by its relation to this result. */
export const actionFields = (actions: readonly CommandAction[]): Field[] =>
  actions.map((action) => ({
    label: action.rel,
    value: [{ code: action.argv.map((arg) => JSON.stringify(arg)).join(" ") }],
  }));

/** What setup would do to each existing installed copy. */
const installedChangesTable = (facts: readonly InstalledSkillChange[]) =>
  Block.Table({
    columns: [{ title: "Skill" }, { title: "State" }, { title: "Path" }, { title: "Reason" }],
    rows: facts.map((fact) => [
      [fact.name],
      [installedSkillChangeLabel(fact)],
      [{ dim: fact.path }],
      fact.reason === undefined ? [] : [installedSkillChangeReason(fact.reason)],
    ]),
  });

/** A group of skill instances: how many, which, in what git states, for which harnesses. */
function collectionFields(input: {
  readonly instances: readonly SetupInstance[];
  readonly rows?: readonly Field[];
  readonly states: string;
}): Block {
  const names = [...new Set(input.instances.map((instance) => instance.name))].sort();
  const harnesses = [...new Set(input.instances.flatMap((instance) => instance.harnesses))]
    .sort()
    .map(harnessLabel);
  return Block.Fields({
    rows: [
      ...(input.rows ?? []),
      { label: "Skills", value: [String(names.length)] },
      ...(input.instances.length === names.length
        ? []
        : [{ label: "Instances", value: [String(input.instances.length)] }]),
      ...(names.length <= setupExpandedSkillLimit
        ? [{ label: "Names", value: [names.join(", ")] }]
        : []),
      { label: "States", value: [input.states] },
      ...(harnesses.length ? [{ label: "Harnesses", value: [harnesses.join(", ")] }] : []),
    ],
  });
}

function setupCollections(data: SetupData): Block[] {
  const { sources, repositories, loose } = data.collectionGroups;
  const gitStates = (instances: readonly SetupInstance[]) =>
    stateCounts(instances, setupGitStateOrder, (instance) => instance.git.status);
  const scopes = new Map<string, number>();
  for (const instance of loose) scopes.set(instance.scope, (scopes.get(instance.scope) ?? 0) + 1);
  return [
    ...(sources.length
      ? [
          Block.Group({
            title: "Installed collections",
            children: sources.map((collection) =>
              Block.Group({
                title: collection.source,
                children: [
                  collectionFields({
                    instances: collection.instances,
                    states: gitStates(collection.instances),
                  }),
                ],
              }),
            ),
          }),
        ]
      : []),
    ...(repositories.length
      ? [
          Block.Group({
            title: "Repository collections (inferred)",
            children: repositories.map((collection) =>
              Block.Group({
                title: basename(collection.repository),
                children: [
                  collectionFields({
                    instances: collection.instances,
                    rows: [
                      {
                        label: "Root",
                        value: [relative(collection.repository, collection.root) || "."],
                      },
                    ],
                    states: gitStates(collection.instances),
                  }),
                ],
              }),
            ),
          }),
        ]
      : []),
    ...(loose.length
      ? [
          Block.Group({
            title: "Loose skills",
            children: [
              collectionFields({
                instances: loose,
                states: [...scopes.entries()]
                  .map(([scope, count]) => `${count} ${scope}`)
                  .join(", "),
              }),
            ],
          }),
        ]
      : []),
  ];
}

function setupInstalledSkills(collections: SetupData["collectionGroups"]["installed"]): Block[] {
  return collections.map(({ displayName, skills }) => {
    const names = [...new Set(skills.map((skill) => skill.name))].sort();
    const harnesses = [...new Set(skills.flatMap((skill) => skill.harnesses))]
      .sort()
      .map(harnessLabel);
    return Block.Group({
      title: displayName,
      children: [
        Block.Fields({
          rows: [
            { label: "Skills", value: [String(names.length)] },
            ...(skills.length === names.length
              ? []
              : [{ label: "Installed copies", value: [String(skills.length)] }]),
            ...(names.length <= setupExpandedSkillLimit
              ? [{ label: "Names", value: [names.join(", ")] }]
              : []),
            {
              label: "Status",
              value: [stateCounts(skills, installedStatuses, (skill) => skill.status)],
            },
            ...(harnesses.length ? [{ label: "Harnesses", value: [harnesses.join(", ")] }] : []),
          ],
        }),
      ],
    });
  });
}

function setupAuthoredCollections(data: SetupData): Block[] {
  return data.collectionGroups.authored.map((collection) => {
    const installed = stateCounts(
      collection.installedSkills,
      installedStatuses,
      (skill) => skill.status,
    );
    const names = collection.skills.map((skill) => skill.name);
    return Block.Group({
      title: `${collection.namespace}/${collection.skit}`,
      children: [
        Block.Fields({
          rows: [
            { label: "Repository", value: [{ dim: collection.repository }] },
            { label: "Authored skills", value: [String(names.length)] },
            { label: "Library", value: [collection.collectionId ? "present" : "missing"] },
            ...(installed
              ? [
                  {
                    label:
                      collection.installedSkills.length === 1
                        ? "Installed copy"
                        : "Installed copies",
                    value: [installed],
                  },
                ]
              : []),
            ...(names.length <= setupExpandedSkillLimit
              ? [{ label: "Names", value: [names.join(", ")] }]
              : []),
            { label: "Origin", value: [collection.origin] },
          ],
        }),
      ],
    });
  });
}

function setupContentMatches(data: SetupData): Block[] {
  const candidates = data.instances.filter(
    (instance) => instance.owner.kind === "unknown" && instance.locks.length === 0,
  );
  const libraryMatches = candidates
    .filter(
      (instance) =>
        instance.contentIdentity.status === "hashed" &&
        instance.contentIdentity.libraryMatches.length > 0,
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  const duplicateHashes = new Map<string, typeof candidates>();
  for (const instance of candidates) {
    const hash =
      instance.contentIdentity.status === "hashed"
        ? instance.contentIdentity.currentHash
        : undefined;
    if (hash) duplicateHashes.set(hash, [...(duplicateHashes.get(hash) ?? []), instance]);
  }
  const duplicates = [...duplicateHashes.values()]
    .filter((instances) => instances.length > 1)
    .sort((left, right) => left[0]!.name.localeCompare(right[0]!.name));
  return [
    ...data.instances.flatMap((instance) => {
      if (instance.contentIdentity.status !== "failed") return [];
      const failure = instance.contentIdentity.failure;
      return [
        Block.Group({
          title: `Could not check ${instance.name}`,
          children: [
            Block.Note({
              text: [
                instance.path,
                "\n",
                failure._tag === "TreeError" ? treeFailure(failure.reason) : errorMessage(failure),
              ],
            }),
          ],
        }),
      ];
    }),
    ...(libraryMatches.length
      ? [
          Block.Group({
            title: "Exact Library matches",
            children: [
              Block.Table({
                columns: [
                  { title: "Skill" },
                  { title: "Git" },
                  { title: "Matches" },
                  { title: "Path" },
                ],
                rows: libraryMatches.map((instance) => [
                  [instance.name],
                  [instance.git.status],
                  [
                    [
                      ...new Set(
                        instance.contentIdentity.status === "hashed"
                          ? instance.contentIdentity.libraryMatches.map((match) => match.name)
                          : [],
                      ),
                    ].join(", "),
                  ],
                  [{ dim: instance.path }],
                ]),
              }),
            ],
          }),
        ]
      : []),
    ...(duplicates.length
      ? [
          Block.Group({
            title: "Equivalent unmanaged copies",
            children: [
              Block.List({
                items: duplicates.map((instances) => ({
                  text: [
                    [...new Set(instances.map((instance) => instance.name))].sort().join(", "),
                    { dim: ` (${instances.length} identical instances)` },
                  ],
                  detail: [{ dim: instances.map((instance) => instance.path).join("\n") }],
                })),
              }),
            ],
          }),
        ]
      : []),
  ];
}

function setupOnboardingPlan(data: SetupData): Block[] {
  if (!data.onboarding.candidates.length) return [];
  type Candidate = (typeof data.onboarding.candidates)[number];
  const actions = new Map<Candidate["action"], Candidate[]>();
  for (const candidate of data.onboarding.candidates)
    actions.set(candidate.action, [...(actions.get(candidate.action) ?? []), candidate]);
  const groups = (
    [
      "import-observed-collection",
      "bind-existing-entry",
      "manage-locally",
      "harness-owned",
      "repository-owned",
      "blocked",
      "leave-alone",
    ] as const
  ).flatMap((action) => {
    const candidates = actions.get(action);
    if (!candidates) return [];
    const reasons = new Map<Extract<Candidate, { action: "blocked" }>["reason"], number>();
    for (const candidate of candidates)
      if (candidate.action === "blocked")
        reasons.set(candidate.reason, (reasons.get(candidate.reason) ?? 0) + 1);
    return [
      Block.Group({
        title: `${setupActionName(action)} (${candidates.length} skill${candidates.length === 1 ? "" : "s"})`,
        children:
          candidates.length <= setupExpandedSkillLimit
            ? [
                Block.List({
                  items: candidates.map((candidate) => {
                    const why =
                      candidate.action === "blocked"
                        ? setupLeftAloneReason(candidate.reason)
                        : candidate.action === "manage-locally" &&
                            candidate.sourceSelection === "required"
                          ? "choose source copy"
                          : undefined;
                    return {
                      text: [candidate.name, ...(why === undefined ? [] : [{ dim: ` (${why})` }])],
                      detail: [{ dim: candidate.paths.join("\n") }],
                    };
                  }),
                }),
              ]
            : action === "blocked"
              ? [
                  Block.Table({
                    columns: [{ title: "Skills", align: "end" }, { title: "Reason" }],
                    rows: [...reasons].map(([reason, count]) => [
                      [String(count)],
                      [setupLeftAloneReason(reason)],
                    ]),
                  }),
                ]
              : [],
      }),
    ];
  });
  return [
    Block.Group({
      title: "Onboarding plan",
      children: [
        Block.Fields({ rows: [{ label: "Plan", value: [data.onboarding.planId.slice(0, 12)] }] }),
        ...groups,
      ],
    }),
  ];
}

/** What `skit setup --apply` would do, and the exact command that does it. */
function setupRecommendation(data: SetupData): Block[] {
  const { candidates, recommended, apply, planId } = data.onboarding;
  if (!recommended.sources.length && !recommended.copies.length) return [];
  const duplicates = recommended.copies.filter((copy) =>
    candidates.some(
      (candidate) => candidate.paths.includes(copy.sourcePath) && candidate.duplicates?.length,
    ),
  );
  return [
    Block.Changes({
      title: "Recommended plan",
      items: [
        ...recommended.sources.map(({ source, names }): Change => ({
          action: "add",
          label: `Import skills.sh Collection ${source}`,
          children: names.map((name) => ({ action: "add", label: name })),
        })),
        ...(recommended.copies.length
          ? [
              {
                action: "add" as const,
                label: "Add to Library",
                children: recommended.copies.map((copy) => ({
                  action: "add" as const,
                  label: copy.name,
                })),
              },
            ]
          : []),
      ],
    }),
    ...(duplicates.length
      ? [
          Block.Status({
            tone: "warn",
            text: [
              `Already visible to agents elsewhere: ${duplicates.map((copy) => copy.name).join(", ")} (choose --duplicates import-only or keep-both)`,
            ],
          }),
        ]
      : []),
    ...(apply === undefined
      ? []
      : [
          Block.Note({
            text: [
              "Apply it without prompts: ",
              { code: setupApplyCommandLine({ planId, ...apply }) },
            ],
          }),
        ]),
  ];
}

/** What `skit setup --apply` did, then why the rest was left alone. */
export function renderSetupApplied(data: ContractDataForId<"skit.setup.applied.v4">): Block[] {
  const applied: Change[] = [
    ...data.imported.map(({ source, names }): Change => ({
      action: "add",
      label: `Imported ${source}`,
      children: names.map((name) => ({ action: "add", label: name })),
    })),
    ...(data.added.length
      ? [
          {
            action: "add" as const,
            label: "Added to Library",
            children: data.added.map((copy) => ({ action: "add" as const, label: copy.name })),
          },
        ]
      : []),
    ...(data.reconnected.length
      ? [
          {
            action: "update" as const,
            label: "Reconnected",
            children: data.reconnected.map((copy) => ({
              action: "update" as const,
              label: copy.name,
            })),
          },
        ]
      : []),
  ];
  const backupWarnings = data.backupWarnings ?? data.aliasesKept;
  return [
    applied.length
      ? Block.Changes({ items: applied })
      : Block.Status({
          tone: "info",
          text: ["Nothing to apply; the plan recommended no changes."],
        }),
    ...(data.installedSkills.length
      ? [
          Block.Group({
            title: "Copies",
            children: [
              Block.Table({
                columns: [
                  { title: "Skill" },
                  { title: "Destination" },
                  { title: "Status" },
                  { title: "Path" },
                ],
                rows: data.installedSkills.map((installedSkill) => [
                  [installedSkill.name],
                  [installedSkill.destination],
                  [installedSkill.status],
                  [{ dim: installedSkill.path }],
                ]),
              }),
            ],
          }),
        ]
      : []),
    ...(data.leftAlone.length
      ? [
          Block.Group({
            title: "Left alone",
            children: [
              Block.Table({
                columns: [{ title: "Skill" }, { title: "Reason" }],
                rows: data.leftAlone.map((skill) => [
                  [skill.name],
                  [setupLeftAloneReason(skill.reason)],
                ]),
              }),
            ],
          }),
        ]
      : []),
    ...(data.aliasRecoveryDirectories?.length
      ? [
          Block.Group({
            title: "Backed-up copies and their move records are saved in",
            children: [
              Block.List({
                items: data.aliasRecoveryDirectories.map((directory) => ({
                  text: [{ dim: directory }],
                })),
              }),
            ],
          }),
        ]
      : []),
    ...(backupWarnings?.length
      ? [
          Block.Group({
            title: "Existing copies left in place",
            children: [
              Block.List({
                items: backupWarnings.map((kept) => ({
                  text: [kept.name],
                  detail: [setupWarning(kept)],
                })),
              }),
            ],
          }),
        ]
      : []),
  ];
}

export function renderSetup(data: SetupData): Block[] {
  const configuredRepositories = data.repositoryConfigs.filter(
    (config) => config.status !== "missing",
  );
  const collections = setupCollections(data);
  return [
    Block.Status({
      tone: "info",
      text: [
        `Found ${data.instances.length} skill instance(s) in ${data.repositories.length} repositories across ${data.machineConfig.repositoryRoots.length} configured root(s).`,
      ],
    }),
    ...(data.machineConfig.persisted
      ? [Block.Status({ tone: "ok", text: ["Roots saved for this machine."] })]
      : []),
    Block.Fields({
      rows: [
        { label: "Scan", value: [data.scan.complete ? "complete" : "incomplete"] },
        { label: "Directories examined", value: [String(data.scan.directoriesExamined)] },
        { label: "Repository depth", value: [String(data.scan.repositorySearchDepth)] },
      ],
    }),
    ...(data.scan.issues?.length
      ? [
          Block.Group({
            title: "Discovery issues",
            children: [
              Block.Table({
                columns: [{ title: "Issue" }, { title: "Path" }],
                rows: data.scan.issues.map((issue) => [[issue.code], [{ dim: issue.path }]]),
              }),
            ],
          }),
        ]
      : []),
    Block.Group({
      title: "Harnesses",
      children: [
        Block.Table({
          columns: [{ title: "Harness" }, { title: "Status" }, { title: "Command" }],
          rows: data.probes.map((probe) => [
            [harnessLabel(probe.harness)],
            [probe.status],
            [{ code: probe.command }],
          ]),
        }),
      ],
    }),
    ...(data.repositories.length
      ? [
          Block.Group({
            title: `Repositories (${data.repositories.length})`,
            children: [
              Block.Table({
                columns: [{ title: "Repository" }, { title: "Skills discovered", align: "end" }],
                rows: data.repositories.map((repository) => [
                  [repository.path],
                  [String(repository.skills.length)],
                ]),
              }),
            ],
          }),
        ]
      : []),
    ...(configuredRepositories.length
      ? [
          Block.Group({
            title: "Repository discovery config",
            children: [
              Block.Table({
                columns: [
                  { title: "Repository" },
                  { title: "Status" },
                  { title: "Exclusions", align: "end" },
                  { title: "Collection roots", align: "end" },
                  { title: "Config" },
                ],
                rows: configuredRepositories.map((config) => [
                  [config.repository],
                  [config.status],
                  [String(config.exclude.length)],
                  [String(config.collections.length)],
                  [{ dim: config.path }],
                ]),
              }),
            ],
          }),
        ]
      : []),
    ...(data.authoredCollections.length
      ? [Block.Group({ title: "Authored SKITs", children: setupAuthoredCollections(data) })]
      : []),
    ...(data.collectionGroups.installed.length
      ? [
          Block.Group({
            title: "Existing SKIT installed skills",
            children: setupInstalledSkills(data.collectionGroups.installed),
          }),
        ]
      : []),
    ...(data.changes?.length
      ? [
          Block.Group({
            title: "Existing managed copies (left unchanged)",
            children: [
              installedChangesTable(data.changes),
              Block.Note({ text: ["Use skit update to handle changes to managed skills."] }),
            ],
          }),
        ]
      : []),
    ...setupContentMatches(data),
    ...setupOnboardingPlan(data),
    ...setupRecommendation(data),
    ...(data.suggestedRepositoryRoots.length
      ? [
          Block.Note({
            text: [
              `Repositories under ${data.suggestedRepositoryRoots.join(", ")} were not scanned. To include their skills:`,
            ],
          }),
          Block.List({
            items: data.suggestedRepositoryRoots.map((root) => ({
              text: [{ code: `skit setup --work-dir ${root}` }],
            })),
          }),
        ]
      : []),
    ...(collections.length
      ? [Block.Group({ title: "Skill collections", children: collections })]
      : []),
    ...(data.instances.length
      ? [
          Block.Group({
            title: "Skill instances",
            children: [
              Block.Table({
                columns: [
                  { title: "Skill" },
                  { title: "Scope" },
                  { title: "Owner" },
                  { title: "Git" },
                  { title: "Harnesses" },
                  { title: "Path" },
                ],
                rows: data.instances.map((item) => [
                  [item.name],
                  [item.scope],
                  [
                    item.owner.kind === "pnpm"
                      ? `Managed by pnpm (${item.owner.package}@${item.owner.version}), left in place`
                      : item.owner.kind === "authored"
                        ? "author-source"
                        : item.owner.kind,
                  ],
                  [item.git.status],
                  [item.harnesses.map(harnessLabel).join(", ")],
                  [{ dim: item.path }],
                ]),
              }),
            ],
          }),
        ]
      : []),
    ...(data.locks.length
      ? [
          Block.Group({
            title: "skills.sh locks",
            children: [
              Block.Table({
                columns: [{ title: "Scope" }, { title: "Status" }, { title: "Path" }],
                rows: data.locks.map((lock) => [[lock.scope], [lock.status], [{ dim: lock.path }]]),
              }),
            ],
          }),
        ]
      : []),
    ...(data.brokenLinks.length
      ? [
          Block.Group({
            title: "Broken links",
            children: [
              Block.Table({
                columns: [{ title: "Link" }, { title: "Target" }],
                rows: data.brokenLinks.map((link) => [
                  [{ dim: link.path }],
                  [{ dim: link.target }],
                ]),
              }),
            ],
          }),
        ]
      : []),
    ...(data.instances.length
      ? []
      : [Block.Status({ tone: "info", text: ["No skill instances found."] })]),
  ];
}

export const renderSetupComparison = (data: ContractData<"setupComparison">): Block[] => [
  ...data.copies.map((copy) =>
    Block.Group({
      title: copy.name,
      children: [
        Block.Fields({
          rows: [{ label: "Path", value: [{ dim: copy.path }] }],
        }),
        Block.Verbatim({ text: copy.markdown }),
        ...(copy.truncated ? [Block.Note({ text: [{ dim: "[Preview truncated]" }] })] : []),
      ],
    }),
  ),
  ...(data.actions.length ? [Block.Fields({ rows: actionFields(data.actions) })] : []),
];

export const renderSetupReview = (data: ContractData<"setupReview">): Block[] => {
  const { summary } = data;
  const changes: Change[] = [
    ...summary.sources.map((source): Change => ({
      action: "add",
      label: `Import ${source.source}`,
      children: source.names.map((name) => ({ action: "add", label: name })),
    })),
    ...summary.enables.map((copy): Change => ({
      action: "add",
      label: `Enable ${copy.name} from ${copy.path}`,
    })),
    ...summary.retains.map((copy): Change => ({
      action: "add",
      label: `Import ${copy.name} from ${copy.path} into the Library`,
    })),
    ...summary.preserves.map((copy): Change => ({
      action: "update",
      label: `Back up ${copy.kind} ${copy.name} from ${copy.path} in recovery`,
    })),
    ...summary.removals.map((copy): Change => ({
      action: "remove",
      label: `Save ${copy.name} from ${copy.path} in recovery`,
    })),
    ...(summary.savesMachineSettings
      ? [{ action: "update" as const, label: "Save the selected machine discovery settings" }]
      : []),
  ];
  return [
    data.hasChanges
      ? Block.Status({ tone: "info", text: ["Review setup changes"] })
      : Block.Status({ tone: "ok", text: ["Nothing to apply"] }),
    ...(summary.sourceUpdateMayNeedReview
      ? [
          Block.Status({
            tone: "warn",
            text: [
              "Setup leaves existing managed copies unchanged. Use skit update to handle their edits or newer Library versions.",
            ],
          }),
        ]
      : []),
    ...(changes.length ? [Block.Changes({ items: changes })] : []),
    ...(data.actions.length ? [Block.Fields({ rows: actionFields(data.actions) })] : []),
  ];
};

export const renderSetupFailed = (data: ContractData<"setupFailed">): Block[] => [
  ...commandFailure(data.cause).presentation,
  ...(data.actions.length ? [Block.Fields({ rows: actionFields(data.actions) })] : []),
];
