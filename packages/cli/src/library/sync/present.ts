import { sourceKinds } from "../presentation/collection-source.js";
import { Block, type Change, type Inline, type ListItem } from "../../terminal/blocks.js";
import {
  SyncConflictDetail,
  SyncEnablementIssue,
  type SyncIssue,
} from "@smolai/skit-core/library/sync";
import { Schema } from "effect";
import { errorMessage } from "@smolai/skit-core/shared";
import { dataFailure } from "../../commands/data-failure.js";
import { installedSkillConflictText } from "../presentation/language.js";
import type { SyncResult } from "./output.js";
import { renderSyncConflicts, syncConflict } from "./conflict.js";

type SyncPlan = NonNullable<SyncResult["plan"]>;
type PlanChange = SyncPlan["local"][number];

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Name a few Skills; past that, count them so a large Collection stays readable. */
const skillChange = (action: Change["action"], names: readonly string[]): Change[] =>
  names.length === 0
    ? []
    : [{ action, label: names.length <= 5 ? names.join(", ") : plural(names.length, "Skill") }];

const sourceDetails = ({
  source_kind,
  authority,
  release_version,
}: {
  readonly source_kind?: keyof typeof sourceKinds;
  readonly authority?: string;
  readonly release_version?: string;
}): readonly string[] => {
  if (source_kind === undefined) return [];
  const host =
    authority === undefined
      ? undefined
      : URL.parse(authority.includes("://") ? authority : `https://${authority}`)?.host ||
        undefined;
  if (source_kind === "registry" && (host !== undefined || release_version !== undefined))
    return [host, release_version].filter((value) => value !== undefined);
  return source_kind === "authored-workspace" && host !== undefined
    ? [sourceKinds[source_kind], host]
    : [sourceKinds[source_kind]];
};

const collectionChange = (change: Extract<PlanChange, { kind: "collection" }>): Change => {
  const details = [
    ...sourceDetails(change),
    ...(change.action === "add" ? [plural(change.skills_added.length, "Skill")] : []),
  ];
  return {
    action: change.action,
    label:
      change.label_before && change.label_after && change.label_before !== change.label_after
        ? `${change.label_before} → ${change.label_after}`
        : change.label,
    ...(details.length > 0 ? { detail: details.join(", ") } : {}),
    ...(change.action === "update"
      ? {
          children: [
            ...skillChange("add", change.skills_added),
            ...skillChange("update", change.skills_changed),
            ...skillChange("remove", change.skills_removed),
          ],
        }
      : {}),
  };
};

const enabledChange = (change: Extract<PlanChange, { kind: "enabled" }>): Change => {
  const entry = (action: Change["action"], item: (typeof change.items_added)[number]): Change => {
    const detail = [item.collection_label, ...sourceDetails(item)]
      .filter((part) => part !== undefined)
      .join(", ");
    return { action, label: item.label, ...(detail === "" ? {} : { detail }) };
  };
  return {
    action: change.action,
    label: "Enabled Skills",
    children: [
      ...change.items_added.map((item) => entry("add", item)),
      ...change.items_removed.map((item) => entry("remove", item)),
    ],
  };
};

export const syncIssue = (issue: SyncIssue): ListItem =>
  Schema.is(SyncConflictDetail)(issue)
    ? { text: [syncConflict(issue, "issue")] }
    : SyncEnablementIssue.match(issue, {
        SelectionMissing: ({ selection }) => ({
          text: [
            "This device selects a ",
            "skill" in selection ? "Skill" : "Collection",
            " that is no longer in the Library.",
          ],
          detail: [
            "Choose this device's selection again with ",
            { code: "--device-skill" },
            " or ",
            { code: "--device-collection" },
            ", or use ",
            { code: "--follow-account" },
            " to follow what is enabled everywhere.",
          ],
        }),
        DuplicateScanFailed: ({ failure }) => ({
          text: ["Could not inspect existing Skill installations."],
          detail: [dataFailure(failure)?.message ?? errorMessage(failure)],
        }),
        ExistingCopy: ({ copy }) => ({
          text: [
            copy.name,
            " already exists at ",
            ...copy.aliases.flatMap((alias, index): Inline[] => [
              ...(index ? [", "] : []),
              { code: alias.path },
              ...(alias.linkPath === undefined
                ? []
                : [
                    " (symlink ",
                    { code: alias.linkPath },
                    " → ",
                    { code: alias.linkTarget ?? copy.canonicalPath },
                    ")",
                  ]),
            ]),
            ".",
          ],
          detail: [
            "Resolves to ",
            { code: copy.canonicalPath },
            ". Review this copy before enabling.",
          ],
        }),
        InstallationFailed: ({ failure }) => ({
          text: ["Could not enable the selected Skills."],
          detail: [dataFailure(failure)?.message ?? errorMessage(failure)],
        }),
        InstalledFolderConflicted: ({ path, conflicts }) => ({
          text: ["Cannot install at ", { code: path }, "."],
          detail: conflicts.length
            ? [
                conflicts.map(installedSkillConflictText).join(" "),
                " Save any edited files and review the folder before retrying.",
              ]
            : [
                "The saved record has no conflict details. Run ",
                { code: "skit doctor" },
                " to check the folder again.",
              ],
        }),
      });

export function presentLibrarySyncPlan(plan: SyncPlan): Block[] {
  // Collections that differ only in fetch records change nothing a person chose or uses.
  const shown = (changes: SyncPlan["local"]) =>
    changes.filter((change) => change.kind !== "collection" || !change.evidence_only);
  const side = (title: string, changes: SyncPlan["local"]) => {
    const collections = changes.flatMap((change) =>
      change.kind === "collection" ? [collectionChange(change)] : [],
    );
    const enabled = changes.flatMap((change) =>
      change.kind === "enabled" ? [enabledChange(change)] : [],
    );
    return Block.Group({
      title,
      children: [
        ...(changes.length === 0 ? [Block.Note({ text: [{ dim: "No changes." }] })] : []),
        ...(collections.length
          ? [Block.Changes({ title: "Collections", items: collections })]
          : []),
        ...(enabled.length ? [Block.Changes({ title: "Enabled", items: enabled })] : []),
      ],
    });
  };
  const changes = [...shown(plan.local), ...shown(plan.remote)];
  const summary = (["add", "update", "remove"] as const).flatMap((action) => {
    const count = changes.filter((change) => change.action === action).length;
    return count === 0 ? [] : [`${count} to ${action}`];
  });
  return [
    Block.Heading({ text: "Library sync plan" }),
    ...(plan.enabled_resolution
      ? [
          Block.Note({
            text: [
              `Enabled-list clashes resolved using this device's choices: ${plan.enabled_resolution.collections.map((collection) => collection.label).join(", ")}.`,
            ],
          }),
        ]
      : []),
    side("This device", shown(plan.local)),
    side("Remote Library", shown(plan.remote)),
    Block.Note({ text: [`Plan: ${summary.join(", ") || "no changes"}.`] }),
  ];
}

export function presentLibrarySync(data: SyncResult): Block[] {
  const folders = data.author_workspaces ?? [];
  return [
    ...(folders.length
      ? [
          Block.Heading({ text: "Author Workspaces" }),
          Block.List({
            items: folders.map((folder) => {
              const failure = folder.failure ?? folder.sync_failure ?? folder.installation_failure;
              const description = failure === undefined ? undefined : dataFailure(failure);
              return {
                text: [
                  folder.identity,
                  ...(folder.directory === undefined ? [] : [" at ", { code: folder.directory }]),
                  " — ",
                  ...(failure !== undefined
                    ? [description?.message ?? errorMessage(failure)]
                    : [
                        folder.sync?.status === "ready"
                          ? `ready to ${folder.sync.action}`
                          : (folder.sync?.status.replaceAll("_", " ") ??
                            (folder.status === "pull_ready"
                              ? "ready to pull"
                              : (folder.installation ?? folder.status))),
                      ]),
                ],
                ...(description?.next.length ? { detail: description.next } : {}),
              };
            }),
          }),
        ]
      : []),
    ...(data.author_inventory_failure === undefined
      ? []
      : [
          Block.Note({
            text: [
              "Author inventory unavailable. ",
              dataFailure(data.author_inventory_failure)?.message ??
                errorMessage(data.author_inventory_failure),
            ],
          }),
        ]),
    ...presentLibrarySyncResult(data),
  ];
}

function presentLibrarySyncResult(data: SyncResult): Block[] {
  // What syncing did to this device, when it did anything worth knowing.
  const notes = [
    ...(data.merge_base === "empty-first-sync"
      ? ["First sync with this Library: merging from an empty base without inferring deletions."]
      : []),
    ...(data.merge_base === "empty-different-library"
      ? [
          "This device last synced with a different Library: merging from an empty base without inferring deletions.",
        ]
      : []),
    ...(data.uninstalled
      ? [`Removed ${plural(data.uninstalled, "Skill")} no longer enabled from this device.`]
      : []),
  ].map((text) => Block.Note({ text: [text] }));
  const status = (tone: "ok" | "info" | "warn" | "error", ...text: Inline[]) =>
    Block.Status({ tone, text });
  switch (data.status) {
    case "clean":
      return [status("ok", "Library is already in sync."), ...notes];
    case "push_ready":
    case "pull_ready":
    case "merge_ready":
      return [
        ...(data.plan ? presentLibrarySyncPlan(data.plan) : []),
        ...notes,
        status("info", "No changes applied. Run ", { code: "skit sync --apply" }, " to apply."),
      ];
    case "pushed":
    case "pulled":
    case "merged":
      return [status("ok", "Library synced."), ...notes];
    case "local_bytes_changed":
      return [
        status("error", "A stored Skill copy on this device changed unexpectedly; sync stopped."),
      ];
    case "conflicted":
      if (data.conflict_details?.length)
        return [
          status("error", "Library sync stopped:"),
          ...renderSyncConflicts(data.conflict_details),
          Block.Note({ text: ["No Library sync changes applied."] }),
          ...notes,
        ];
      return [
        status("error", "Library sync stopped."),
        Block.Note({
          text: ["This result has no named conflict details or confirmed resolution choices."],
        }),
        Block.Note({
          text: [
            "Preview the current conflicts with ",
            { code: "skit sync" },
            " before choosing a resolution. No Library sync changes applied.",
          ],
        }),
        ...notes,
      ];
    case "resolution_invalid":
      return [
        status(
          "error",
          "The requested resolution isn't available. Use ",
          { code: "--take-remote" },
          " for a listed resolvable conflict, or ",
          { code: "--keep-enabled" },
          " for one Skill in a listed destination collision.",
        ),
      ];
    case "enablement_incomplete":
      return [
        status("warn", "Library synced, but enablement is incomplete:"),
        Block.List({
          items: data.enablement_issues?.length
            ? data.enablement_issues.map(syncIssue)
            : [{ text: ["Inspect the selected Skills."] }],
        }),
        Block.Note({
          text: ["Resolve the listed issues, then run ", { code: "skit sync --apply" }, " again."],
        }),
      ];
  }
}
