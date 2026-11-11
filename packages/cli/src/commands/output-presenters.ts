import { authCleanupDetails } from "../registry/auth-failures.js";
import { harnessProbeFailure } from "../platform/probe-failures.js";
import { classifyFailure } from "./failure-classification.js";
import { authoredSkillIssueLines } from "../library/authored-skill-issues.js";
import { validationDiagnostic } from "../platform/validation-diagnostic.js";
import { metadataSource, metadataRevision } from "../library/presentation/skill-metadata.js";
import { renderSecurityReview } from "../library/security/present.js";
import { renderRepositoryPolicy } from "../library/repository/present.js";
import type { ContractData, ContractDataForId, ContractKey } from "./output-contracts.js";
import type { CommandResult } from "./types.js";
import type { RenderContext } from "../terminal/contracts.js";
import { terminalData } from "../terminal/text.js";
import { Block, renderBlocks } from "../terminal/blocks.js";
import { harnessLabel } from "@smolai/skit-core/harnesses";
import { renderUsage } from "../library/usage/present.js";
import { renderInventory } from "../library/inventory/present.js";
import { renderSetEnabled } from "../library/enable.js";
import { renderRemove, renderRemovePlan } from "../library/remove/present.js";
import { renderCheck } from "../library/check/present.js";
import { presentLibrarySync } from "../library/sync.js";
import { renderLibraryList } from "../library/list.js";
import { presentAuditV1Alpha4 } from "../audit/presentation/report.js";
import { renderAdd, renderAddPreview } from "../library/add/present.js";
import { renderUpdate, renderUpdatePlan } from "../library/update/present.js";
import { renderDoctor } from "../library/doctor/present.js";
import {
  renderSetup,
  renderSetupApplied,
  renderSetupComparison,
  renderSetupReview,
  renderSetupFailed,
  renderSetupUndo,
} from "../library/setup.js";
import { renderRecoveryList, renderRecovery } from "../library/recovery/present.js";
import { renderLibraryHistory } from "../library/history/present.js";
import { renderEditImport, renderEditImportPlan } from "../library/update/installed-edit.js";
import {
  collectionTitle,
  workspaceEnableCommand,
  workspaceInitCommand,
} from "../library/presentation/collection-source.js";

type ContractPresenters = {
  [K in ContractKey]: (data: ContractData<K>, context: RenderContext) => readonly Block[];
};

const diagnosticTones = { info: "info", warning: "warn", error: "error" } as const;

function presentValidation(data: ContractDataForId<"skit.validate.v3">): Block[] {
  const headline = {
    valid: { tone: "ok", text: "SKIT is valid" },
    "valid-with-warnings": { tone: "warn", text: "SKIT is valid with warnings" },
    "policy-blocked": {
      tone: "error",
      text: "SKIT is structurally valid but blocked by security policy",
    },
    invalid: { tone: "error", text: "SKIT validation failed" },
  } as const;
  return [
    Block.Status({ tone: headline[data.status].tone, text: [headline[data.status].text] }),
    ...data.diagnostics.map((diagnostic) =>
      Block.Status({
        tone: diagnosticTones[diagnostic.severity],
        text: [
          validationDiagnostic(diagnostic),
          ...(diagnostic.path ? [" ", { dim: `(${diagnostic.path})` }] : []),
        ],
      }),
    ),
  ];
}

function presentAuthorInit(data: ContractDataForId<"skit.init.v1">): Block[] {
  return [
    Block.Status({ tone: "ok", text: ["Initialized SKIT at ", { dim: data.path }] }),
    ...(data.library_registration === "removed"
      ? [
          Block.Status({ tone: "warn", text: ["Library Entry remains removed."] }),
          Block.Note({
            text: ["Run ", { code: "skit author init --register" }, " to restore it."],
          }),
        ]
      : []),
    ...(data.discovered?.skillEntries.length
      ? [
          Block.Group({
            title: "Discovered Skills",
            children: [
              Block.List({
                items: data.discovered.skillEntries.map((skill) => ({
                  text: [skill.name],
                  detail: [{ dim: skill.path }],
                })),
              }),
            ],
          }),
        ]
      : []),
  ];
}

function presentAuthorInvocation(data: ContractDataForId<"skit.author.invocation.v1">): Block[] {
  const changed = data.generated.filter((item) => item.changed);
  if (!changed.length)
    return [
      Block.Status({
        tone: "ok",
        text: ["Every declared invocation policy is already written into its Harness metadata"],
      }),
    ];
  return [
    data.dryRun
      ? Block.Status({
          tone: "warn",
          text: ["These files do not yet express their declared invocation policy"],
        })
      : Block.Status({ tone: "ok", text: ["Wrote the declared invocation policy into"] }),
    Block.Table({
      columns: [{ title: "File" }, { title: "Skill" }, { title: "Harness" }, { title: "Policy" }],
      rows: changed.map((item) => [
        [{ dim: item.path }],
        [item.skill],
        [item.harness],
        [item.policy],
      ]),
    }),
  ];
}

function presentAuthorDelete(data: ContractDataForId<"skit.author.delete.v2">): Block[] {
  if (data.status === "absent")
    return [Block.Status({ tone: "ok", text: [`${data.skit_id} is already absent`] })];
  return [
    data.status === "delete_ready"
      ? Block.Status({ tone: "info", text: [`Would delete ${data.skit_id}`] })
      : Block.Status({ tone: "ok", text: [`Deleted ${data.skit_id}`] }),
    Block.Fields({
      rows: [
        { label: "Revisions", value: [String(data.revisions)] },
        {
          label: "Releases",
          value: data.release_versions.length
            ? [data.release_versions.join(", ")]
            : [{ dim: "none" }],
        },
        ...(data.status === "deleted" && data.archive_cleanup === "deferred"
          ? [{ label: "Archive cleanup", value: ["deferred"] }]
          : []),
      ],
    }),
  ];
}

function registryLabel(registry: string): string {
  try {
    return new URL(registry).host;
  } catch {
    return registry;
  }
}

function authoredSkitLabel(identity: string): string {
  try {
    return new URL(identity).pathname.replace(/^\//, "");
  } catch {
    return identity;
  }
}

function presentAuthorList(data: ContractDataForId<"skit.author.list.v2">): Block[] {
  const registry = Block.Fields({
    rows: [{ label: "Registry", value: [registryLabel(data.registry)] }],
  });
  if (!data.skits.length)
    return [Block.Status({ tone: "info", text: ["No authored SKITs"] }), registry];
  return [
    Block.Heading({
      text: `${data.skits.length} authored ${data.skits.length === 1 ? "SKIT" : "SKITs"}`,
    }),
    registry,
    Block.Table({
      columns: [{ title: "SKIT" }, { title: "Access" }, { title: "Current" }, { title: "Latest" }],
      rows: data.skits.map((skit) => [
        [authoredSkitLabel(skit.identity)],
        [skit.visibility],
        [skit.current_revision_published ? "published" : "unpublished"],
        [skit.most_recent_release_version ?? { dim: "—" }],
      ]),
    }),
  ];
}

function presentRegistryChange(data: ContractDataForId<"skit.registry.remote.v1">): Block[] {
  switch (data.action) {
    case "removed":
      return [Block.Status({ tone: "ok", text: [`Removed Registry ${data.name}`] })];
    case "defaulted":
      return [
        Block.Fields({
          rows: [{ label: "Default Registry", value: [data.name, " ", { dim: data.origin }] }],
        }),
      ];
    case "added":
      return [Block.Fields({ rows: [{ label: data.name, value: [{ dim: data.origin }] }] })];
  }
}

function presentRegistryList(data: ContractDataForId<"skit.registry.list.v1">): Block[] {
  if (!data.registries.length)
    return [Block.Status({ tone: "info", text: ["No Registries configured"] })];
  return [
    Block.Table({
      columns: [{ title: "Registry" }, { title: "Origin" }],
      rows: data.registries.map((registry) => [
        [registry.name, ...(registry.isDefault ? [" ", { dim: "(default)" }] : [])],
        [registry.origin],
      ]),
    }),
  ];
}

const authScopeLabels: Readonly<Record<string, string>> = {
  "library:sync": "Library sync",
  "authoring:write": "authoring",
  "publication:write": "publication",
};

function authAccess(scopes: ReadonlyArray<string>): string {
  if (!scopes.length) return "Unknown";
  return scopes.map((scope) => authScopeLabels[scope] ?? scope).join(", ");
}

function authExpiry(expiresAt: string | undefined): string {
  if (!expiresAt) return "Unknown";
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return expiresAt;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(expiry);
}

function presentAuthStatus(
  data: ContractDataForId<"skit.auth.status.v3">,
  context: RenderContext,
): Block[] {
  if (!data.credentials.length)
    return [
      Block.Status({ tone: "info", text: ["No credentials configured."] }),
      Block.Note({ text: ["Run ", { code: "skit auth login" }, "."] }),
    ];
  return data.credentials.map((credential) => {
    const name = credential.aliases.join(", ") || credential.origin;
    const flags = [
      credential.isDefault ? "default" : undefined,
      credential.source === "environment" ? "environment" : undefined,
    ].filter(Boolean);
    return Block.Group({
      title: `Credential configured for ${name}${flags.length ? ` (${flags.join(", ")})` : ""}`,
      children: [
        Block.Fields({
          rows: [
            ...(credential.aliases.length
              ? [{ label: "Registry", value: [credential.origin] }]
              : []),
            { label: "Access", value: [authAccess(credential.scopes)] },
            {
              label: "Expires",
              value: [
                authExpiry(credential.expiresAt),
                ...(credential.expired ? [" ", { emph: "(expired)" }] : []),
              ],
            },
            {
              label: "Stored in",
              value: [
                {
                  keychain: "macOS Keychain",
                  "secret-service": "the system secret store",
                  file: "the credential file (no system secret store was available)",
                  environment: "SKIT_TOKEN",
                }[credential.storage],
              ],
            },
            ...(context.detail === "full"
              ? [{ label: "Credential", value: [credential.tokenPrefix] }]
              : []),
          ],
        }),
      ],
    });
  });
}

function presentAuthLogin(
  data: ContractDataForId<"skit.auth.login.v3">,
  context: RenderContext,
): Block[] {
  const name = data.alias ?? data.origin;
  return [
    Block.Status({
      tone: "ok",
      text: [
        `${data.alreadyAuthenticated ? "Already authenticated" : "Authenticated"} to ${name}${data.defaultRegistry && data.defaultRegistry === data.alias ? " (default)" : ""}`,
      ],
    }),
    Block.Fields({
      rows: [
        ...(data.alias ? [{ label: "Registry", value: [data.origin] }] : []),
        { label: "Access", value: [authAccess(data.scopes)] },
        { label: "Expires", value: [authExpiry(data.expiresAt)] },
        ...(data.credentialPath
          ? [{ label: "Saved credential", value: [{ dim: data.credentialPath }] }]
          : []),
        ...(context.detail === "full" ? [{ label: "Credential", value: [data.tokenPrefix] }] : []),
      ],
    }),
    Block.Note({
      text: [
        "Next, run ",
        { code: "skit sync" },
        " to preview and ",
        { code: "skit sync --apply" },
        " to apply. No login needed for future commands.",
      ],
    }),
    ...(data.warning
      ? [
          Block.Status({
            tone: "warn",
            text: [
              "The new credential is active. Previous credential ",
              { code: data.warning.tokenId },
              " (",
              { code: data.warning.tokenPrefix },
              ") could not be revoked and may still be live.",
            ],
          }),
          ...authCleanupDetails(data.warning.cleanup),
          Block.Fields({
            rows: [{ label: "Next", value: ["Revoke the previous credential at the Registry."] }],
          }),
        ]
      : []),
  ];
}

function presentHarnessProbe(
  data: ContractDataForId<"skit.experimental.harness-probe.v1alpha1">,
): Block[] {
  return data.probes.map((probe) =>
    Block.Group({
      title: harnessLabel(probe.harnessId),
      children: [
        Block.Fields({
          rows: [
            {
              label: "Status",
              value: [
                { installed: "Installed", missing: "Not installed", failed: "Probe failed" }[
                  probe.status
                ],
              ],
            },
            { label: "Executable", value: [probe.executablePath ?? { dim: "not found" }] },
            { label: "Resolved", value: [probe.resolvedPath ?? { dim: "n/a" }] },
            { label: "Version", value: [probe.version ?? { dim: "unknown" }] },
            ...(probe.failure
              ? [{ label: "Error", value: [harnessProbeFailure(probe.failure)] }]
              : []),
          ],
        }),
      ],
    }),
  );
}

/** Which version a merge kept for each path both sides changed. */
const mergeChoices = (
  choices: ReadonlyArray<{ readonly path: string; readonly kept: string; readonly kind: string }>,
): Block[] =>
  choices.length
    ? [
        Block.List({
          items: choices.map((choice) => ({
            text: [choice.path],
            detail: [`kept the ${choice.kept} version (${choice.kind})`],
          })),
        }),
      ]
    : [];

const rerunWithApply = Block.Note({ text: ["Rerun with ", { code: "--apply" }, "."] });

function presentAuthorSync(data: ContractDataForId<"skit.author.sync.v5">): Block[] {
  switch (data.status) {
    case "first_sync_ready":
      return [
        Block.Status({
          tone: "info",
          text: [`Sync ready for ${data.identity.locator} (${data.visibility})`],
        }),
        Block.Note({ text: ["No Release will be published."] }),
        rerunWithApply,
      ];
    case "ready":
      return [Block.Status({ tone: "info", text: [`Ready to ${data.action}`] }), rerunWithApply];
    case "blocked":
      return [
        Block.Status({
          tone: "warn",
          text: [`Sync paused: ${data.deleting} of ${data.of} files removed.`],
        }),
        Block.Note({
          text: [
            "Remote files are unchanged. To send these deletions, rerun with ",
            { code: "--apply --allow-large-deletion" },
            ".",
          ],
        }),
      ];
    case "waiting_for_removal":
      return [
        Block.Status({
          tone: "info",
          text: [`Waiting for stable removal of ${data.deleting} file(s) before synchronizing.`],
        }),
      ];
    case "created":
      return [
        Block.Status({ tone: "ok", text: [`Connected ${data.identity.locator}`] }),
        Block.Fields({
          rows: [{ label: "Saved revision", value: [metadataRevision(data.revision_id)] }],
        }),
      ];
    case "up_to_date":
      return [
        Block.Status({
          tone: "ok",
          text: [`Workspace is already synchronized (${metadataRevision(data.revision_id)})`],
        }),
      ];
    case "pulled":
      return [
        Block.Status({
          tone: "ok",
          text: [
            `Updated ${data.paths.length} file(s) from the Registry (${metadataRevision(data.revision_id)})`,
          ],
        }),
      ];
    case "pushed":
      return [
        Block.Status({
          tone: "ok",
          text: [`Synced local changes to the Registry (${metadataRevision(data.revision_id)})`],
        }),
      ];
    case "merged":
      return [
        Block.Status({
          tone: "ok",
          text: [`Merged local and remote changes (${metadataRevision(data.revision_id)})`],
        }),
        ...mergeChoices(data.choices),
      ];
  }
}

function presentAuthorWatch(data: ContractDataForId<"skit.author.watch.v1">): Block[] {
  switch (data.event) {
    case "watching":
      return [
        Block.Status({
          tone: "info",
          text: ["Watching ", { dim: metadataSource(data.path) }, ". Press Ctrl-C to stop."],
        }),
      ];
    case "saved_locally":
      return [
        Block.Status({
          tone: "info",
          text: [
            `Workspace changed (${data.trigger === "filesystem" ? "filesystem event" : "rescan"})`,
          ],
        }),
        Block.List({ items: data.paths.map((path) => ({ text: [{ dim: path }] })) }),
        Block.Status({
          tone: "ok",
          text: [`Saved revision ${metadataRevision(data.revision_id)}.`],
        }),
      ];
    case "sync": {
      const sync = data.result;
      switch (sync.status) {
        case "pushed":
          return [
            Block.Status({
              tone: "ok",
              text: [`Registry upload: ${metadataRevision(sync.revision_id)}.`],
            }),
          ];
        case "pulled":
          return [
            Block.Status({
              tone: "ok",
              text: [`Registry download (${metadataRevision(sync.revision_id)})`],
            }),
            Block.List({ items: sync.paths.map((path) => ({ text: [{ dim: path }] })) }),
          ];
        case "merged":
          return [
            Block.Status({
              tone: "ok",
              text: [`Merged Registry changes (${metadataRevision(sync.revision_id)})`],
            }),
            Block.List({ items: sync.paths.map((path) => ({ text: [{ dim: path }] })) }),
            ...mergeChoices(sync.choices),
          ];
        default:
          return presentAuthorSync(sync);
      }
    }
    case "installation": {
      if (data.status === "unregistered")
        return [
          Block.Status({
            tone: "warn",
            text: ["Workspace removed from the Library; installed copies unchanged."],
          }),
          Block.Note({
            text: ["To register, run ", { code: workspaceInitCommand(data.path) }, "."],
          }),
        ];
      const context =
        data.reason === "startup" || data.reason === "configuration-changed"
          ? data.context
          : undefined;
      return [
        ...(context === undefined
          ? []
          : [
              Block.Group({
                title: data.reason === "startup" ? "Startup" : "Library configuration changed",
                children: [
                  Block.Fields({
                    rows: [
                      {
                        label: "Collection",
                        value: [collectionTitle(context.collection_label, context.source)],
                      },
                      {
                        label: "Enabled",
                        value: [
                          `${context.total - context.disabled_skills.length}/${context.total} skills`,
                        ],
                      },
                      ...(context.disabled_skills.length &&
                      context.disabled_skills.length !== context.total
                        ? [{ label: "Disabled", value: [context.disabled_skills.join(", ")] }]
                        : []),
                    ],
                  }),
                  ...(context.disabled_skills.length
                    ? [
                        ...(context.disabled_skills.length === context.total
                          ? [Block.Note({ text: ["Workspace skills are saved but disabled."] })]
                          : []),
                        Block.Note({
                          text: [
                            "To enable, run ",
                            { code: workspaceEnableCommand(data.path) },
                            ".",
                          ],
                        }),
                      ]
                    : []),
                ],
              }),
            ]),
        ...data.installed_copies.map((copy) =>
          Block.Status({
            tone: "ok",
            text: [
              `Updated ${copy.skill} at `,
              { dim: metadataSource(copy.path) },
              ...(data.revision_id
                ? [` (workspace revision ${metadataRevision(data.revision_id)})`]
                : []),
              ".",
            ],
          }),
        ),
        ...(context?.other_sources.map((copy) =>
          Block.Status({
            tone: "warn",
            text: [
              `${copy.skill} at `,
              { dim: metadataSource(copy.path) },
              ` follows ${collectionTitle(copy.collection_label, copy.source)}.`,
            ],
          }),
        ) ?? []),
        ...(context?.other_sources.length && data.reason === "startup"
          ? [
              Block.Note({
                text: [
                  "Use ",
                  { code: "skit list" },
                  " to choose which source to disable before enabling this workspace.",
                ],
              }),
            ]
          : []),
        ...(data.status === "held"
          ? [
              Block.Status({
                tone: "warn",
                text: ["Invalid workspace inputs; keeping the last valid installed copies."],
              }),
            ]
          : []),
        ...authoredSkillIssueLines(data.issues).map((issue) =>
          Block.Status({ tone: "warn", text: [issue] }),
        ),
        ...(data.reason === "issues-changed" && data.issues.length === 0 && data.status !== "held"
          ? [
              Block.Status({
                tone: "ok",
                text: ["Installation checks clear; no copies needed updating."],
              }),
            ]
          : []),
      ];
    }
    case "retrying": {
      const failure = classifyFailure(data.failure);
      return [
        Block.Status({
          tone: "warn",
          text: [`${data.operation}: retrying`],
        }),
        Block.Group({ title: "Reason", children: failure.explanation }),
        ...(failure.next.length
          ? [Block.Fields({ rows: [{ label: "Next", value: failure.next }] })]
          : []),
        Block.Note({ text: ["Retrying automatically; repeated failures stay quiet."] }),
      ];
    }
    case "recovered":
      return [Block.Status({ tone: "ok", text: [`${data.operation}: recovered.`] })];
  }
}

const contractPresenters: ContractPresenters = {
  versionReport: (data) => [
    Block.Heading({ text: `${data.version} (${data.build.kind})` }),
    ...(data.build.commit
      ? [Block.Fields({ rows: [{ label: "Commit", value: [data.build.commit] }] })]
      : []),
    ...(data.update.status === "update-available"
      ? [
          Block.Status({ tone: "info", text: [`Update available: ${data.update.available}`] }),
          ...(data.update.upgrade ? [Block.Note({ text: [{ code: data.update.upgrade }] })] : []),
        ]
      : data.update.status === "check-unavailable"
        ? [Block.Status({ tone: "warn", text: ["Update check unavailable."] })]
        : data.update.status === "development-build"
          ? [
              Block.Status({
                tone: "info",
                text: ["Development build; release versions are not compared."],
              }),
            ]
          : data.update.status === "channel-unavailable"
            ? [
                Block.Status({
                  tone: "warn",
                  text: [`No usable release on ${data.update.channel}.`],
                }),
              ]
            : data.update.status === "ahead"
              ? [
                  Block.Status({
                    tone: "info",
                    text: [`Ahead of ${data.update.channel} (${data.update.available}).`],
                  }),
                ]
              : [Block.Status({ tone: "ok", text: [`Up to date on ${data.update.channel}.`] })]),
  ],
  version: (data) => [Block.Note({ text: [data.version] })],
  completions: (data) => [Block.Verbatim({ text: data.script })],
  init: presentAuthorInit,
  authorInvocation: presentAuthorInvocation,
  authorWatch: presentAuthorWatch,
  authorDelete: presentAuthorDelete,
  publish: (data) => [
    Block.Status({
      tone: "ok",
      text: [
        `Published ${data.release.version}`,
        ...(data.release.revision_id
          ? [` from ${metadataRevision(data.release.revision_id)}`]
          : []),
      ],
    }),
  ],
  sync: presentAuthorSync,
  librarySync: presentLibrarySync,
  libraryHistory: renderLibraryHistory,
  list: renderLibraryList,
  experimentalAuditV1Alpha4: presentAuditV1Alpha4,
  authorList: presentAuthorList,
  add: renderAdd,
  addPreview: renderAddPreview,
  update: renderUpdate,
  updatePlan: renderUpdatePlan,
  installedEditPlan: renderEditImportPlan,
  installedEdit: renderEditImport,
  remove: renderRemove,
  removePlan: renderRemovePlan,
  enable: (data) => renderSetEnabled(data, true),
  enablePlan: (data) => renderSetEnabled(data, false),
  disable: (data) => renderSetEnabled(data, true),
  disablePlan: (data) => renderSetEnabled(data, false),
  doctor: renderDoctor,
  usage: (data) => renderUsage(data),
  inventory: renderInventory,
  setupUndo: renderSetupUndo,
  recoveryList: renderRecoveryList,
  recovery: renderRecovery,
  setupComparison: renderSetupComparison,
  setupReview: renderSetupReview,
  setupFailed: renderSetupFailed,
  setup: renderSetup,
  setupApplied: renderSetupApplied,
  repositoryPolicy: renderRepositoryPolicy,
  authLogout: (data) => [Block.Status({ tone: "ok", text: [`Logged out from ${data.origin}`] })],
  feedbackSend: (data) => {
    const from = [
      ...(data.signedIn ? ["signed in"] : []),
      ...(data.email === undefined ? [] : [`with contact ${data.email}`]),
    ];
    return [
      Block.Status({
        tone: "ok",
        text: [
          `Sent feedback to ${data.recipient} (${data.id})${from.length === 0 ? ", anonymously" : `, ${from.join(" ")}`}. Thank you.`,
        ],
      }),
    ];
  },
  authStatus: presentAuthStatus,
  authLogin: presentAuthLogin,
  authLoginPending: (data) => [
    Block.Note({
      text: [
        "Open ",
        { emph: data.verificationUri },
        " and enter the code ",
        { emph: data.userCode },
        " to approve this login.",
      ],
    }),
    Block.Note({ text: [`The code expires at ${data.expiresAt}.`] }),
    Block.Note({ text: ["Next, run ", { code: data.next }, " once it is approved."] }),
  ],
  registryRemote: presentRegistryChange,
  registryList: presentRegistryList,
  serverBootstrap: (data) => [
    Block.Status({
      tone: "ok",
      text: [
        data.status === "already_complete"
          ? `Server setup was already complete at ${data.origin}`
          : `Server setup complete at ${data.origin}`,
      ],
    }),
    Block.Note({
      text: [
        "If email verification is enabled, follow the browser result. If delivery failed, use Resend on the sign-in page.",
      ],
    }),
    Block.Note({ text: ["Next, run ", { code: `skit auth login ${data.origin}` }, "."] }),
  ],
  check: renderCheck,
  experimentalHarnessProbe: presentHarnessProbe,
  validate: presentValidation,
  securityReview: renderSecurityReview,
  securityAccept: renderSecurityReview,
};

/** What a result's presenter says. */
export function presentContract<K extends ContractKey>(
  result: CommandResult<K>,
  context: RenderContext,
): readonly Block[] {
  return contractPresenters[result.contract](terminalData(result.data), context);
}

export function renderContract<K extends ContractKey>(
  result: CommandResult<K>,
  context: RenderContext,
): string {
  return renderBlocks(presentContract(result, context), context);
}
