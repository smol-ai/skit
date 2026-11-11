import { SchemaAST } from "effect";
import {
  SyncStateInvalidReason,
  WorkspaceUnsafeReason,
  AuthorWorkspaceInvariantReason,
} from "@smolai/skit-core/author/workspace-contracts";
import { AuthorHistoryInvalidReason } from "@smolai/skit-core/author/history-failures";

/** Inventory entries without a recording are deliberate, visible gaps. Inspected regression
 * tests are not promoted into recordings or claimed as executed by this catalog. */
export const authorSyncGaps = [
  [
    "destination-forms-and-visibility",
    "Private, unlisted and public first creation; shorthand and canonical destination forms; invalid flag combinations.",
  ],
  [
    "library-workspace-identity",
    "Reuse an existing Library workspace identity rather than minting a second one.",
  ],
  [
    "pending-destination-mismatch",
    "A pending creation's destination or visibility differs from the retry; connected replacement flags are refused.",
  ],
  [
    "remote-home-write-failed",
    "Creation succeeded but recording skit.remote.json fails; keep the saved request and resume.",
  ],
  [
    "matching-leftover",
    "A connected workspace has a matching leftover connection receipt; clean it only on apply.",
  ],
  [
    "invalid-or-mismatched-leftover",
    "Refuse unreadable or mismatched connection receipts without deleting them.",
  ],
  [
    "independent-text-and-frontmatter",
    "Merge independent edits in one file and SKILL frontmatter while keeping valid metadata.",
  ],
  [
    "binary-and-descriptor-overlap",
    "Binary and descriptor overlap kinds, both winner directions, and kept losing revisions.",
  ],
  [
    "rename-and-structural-replacement",
    "Rename plus concurrent edit and structural replacement interrupted between individual filesystem changes.",
  ],
  [
    "stable-removal-grace",
    "The same small missing set remains absent for the real ten-second grace period before acceptance.",
  ],
  [
    "removal-grace-reset",
    "Reappearance, a changed missing set, restart or unreadable membership restarts runtime confirmation.",
  ],
  [
    "all-known-items-removed",
    "Removal of every known file or every known member blocks regardless of item count.",
  ],
  [
    "changed-removal-approval",
    "An approval applies to the exact removal checked under its lease; a changed set needs a fresh decision.",
  ],
  [
    "held-removal-independent-edits",
    "Held removal coexists with independent edits and newer remote current without granting removal authority.",
  ],
  [
    "unreadable-membership",
    "Invalid descriptor membership may be backed up but cannot authorize removals.",
  ],
  [
    "sending-other-device-advanced",
    "Resume Sending after another device advances current; merge rather than overwrite it.",
  ],
  [
    "writing-newer-remote",
    "Resume Writing with a newer remote revision, repeated interruption or structural replacement.",
  ],
  [
    "observation-and-checkpoint-races",
    "Replan when local files or the saved checkpoint move between workspace scan, preparation and application.",
  ],
  [
    "unsettled",
    "Eight unsuccessful planning steps end in Sync.Unsettled rather than spinning indefinitely.",
  ],
  [
    "history-only-backup",
    "Upload raw file states without moving current; resume acknowledgements and safely repeat a lost POST.",
  ],
  [
    "broken-backup-ancestry",
    "Refuse disconnected, nonancestor or parent-mismatched backup acknowledgement chains.",
  ],
  [
    "invalid-content-and-normalization",
    "Sync validity is separate from Release publication; raw history backup survives unsafe normalization refusal.",
  ],
  [
    "workspace-lock-and-metadata",
    "Busy lease, unsafe root/control/lock, malformed workspace identity and duplicate registration.",
  ],
  [
    "history-and-shared-storage",
    "History journal/blob failures, history contention, Library/settings failures and HomeBusy.",
  ],
  [
    "unicode-symlink-and-editor-races",
    "NFC twins, unsupported paths, unchecked paths, unsafe tree entries and files changing during sync.",
  ],
  [
    "registry-auth-and-permissions",
    "Missing or unusable credentials, missing scopes, unauthorized principal and unavailable SKIT.",
  ],
  [
    "registry-selection-and-origin",
    "Ambiguous selection, unknown aliases, invalid origins and insecure origins.",
  ],
  [
    "protocol-response-and-deadline",
    "Invalid responses, failed author requests and request deadlines at create/current/read/page/post/move boundaries.",
  ],
].map(([name, description]) => ({ name: name!, description: description! }));

const tags = (ast: SchemaAST.AST): string[] => {
  const type = SchemaAST.toType(ast);
  if (SchemaAST.isUnion(type)) return type.types.flatMap(tags);
  if (SchemaAST.isObjects(type)) {
    const tag = type.propertySignatures.find((property) => property.name === "_tag");
    return tag ? tags(tag.type) : [];
  }
  return SchemaAST.isLiteral(type) && typeof type.literal === "string" ? [type.literal] : [];
};

export const authorSyncDetails = [
  {
    title: "What sync changes",
    body: "Author sync brings an Author Workspace and Registry current together. It does not publish a Release or update installed copies. A preview leaves authored files and Registry current unchanged, but an identified workspace may save local file states and upload history backups.",
    source: "packages/skit/src/author/sync.ts",
  },
  {
    title: "Identity and connection",
    body: "Workspace identity is absent or present. Connection is Unconnected → Connecting → Connected. Connecting saves the creation request id for replay after interruption. A connected workspace can have None, Matching, Mismatched or Invalid leftover receipt; only a matching receipt is safe to clean. Library registration may supply the workspace identity.",
    source: "packages/skit/src/author/workspace-contracts.ts",
  },
  {
    title: "Durable sync checkpoint",
    body: "Idle remembers a null or revision merge base. Sending remembers the base and revision being sent. Writing remembers from/to and the next Idle or Sending checkpoint. Save Writing before applying files; restart resumes it while keeping newer local edits. Save Sending before moving current; a lost response must not turn a retry into an overwrite.",
    source: "packages/skit/src/sync/sync.ts",
  },
  {
    title: "Removal guard",
    body: "Clear, Confirming, Blocked and Unreadable are runtime states. A stable small removal waits ten seconds. Removing every known item, or more than five and more than half, blocks. Apply the rule independently to known files and collection members. Explicit approval authorizes the exact checked removal. Restart, unreadability and a changed missing set restart confirmation. Accepted inventories and removals are durable; the timer is not.",
    source: "packages/skit/src/author/inventory.ts",
  },
  {
    title: "Merge decisions and kept inputs",
    body: "Independent edits combine. Overlap kinds are both_modified, delete_modify, binary and descriptor. An edit beats deletion; the edit seen later wins other overlaps, with local winning equal times. Sync order is not edit time. Report choices and keep input revisions, including the losing content, in history.",
    source: "packages/skit/src/sync/merge.ts",
  },
  {
    title: "History backup and lease",
    body: "Raw file states and their backup acknowledgement are separate from Registry current. The acknowledgement is absent or names the last acknowledged file state. A workspace lease is held or closed; prepared writes belong to that lease and checkpoint and can be used once. These are internal protocols, not additional command result statuses.",
    source: "packages/skit/src/author/backup.ts",
  },
  ...(
    [
      [
        "AuthorSyncStateInvalid",
        SyncStateInvalidReason,
        "packages/skit/src/author/workspace-contracts.ts",
      ],
      [
        "AuthorWorkspaceUnsafe",
        WorkspaceUnsafeReason,
        "packages/skit/src/author/workspace-contracts.ts",
      ],
      [
        "AuthorHistoryInvalid",
        AuthorHistoryInvalidReason,
        "packages/skit/src/author/history-failures.ts",
      ],
      [
        "AuthorWorkspaceInvariantFailed (internal defect)",
        AuthorWorkspaceInvariantReason,
        "packages/skit/src/author/workspace-contracts.ts",
      ],
    ] as const
  ).map(([name, schema, source]) => ({
    title: `${name}: reason branches`,
    body: `Source-defined reasons: ${tags(schema.ast).join(", ")}. A class-level output example does not verify these branches. Unless a scenario explicitly names a reason, its rendering and recovery remain unverified in Atlas.`,
    source,
  })),
  {
    title: "Failure boundaries",
    body: "The checked-error list is derived from the executable command type, not a claim that each error is independently reachable. ConfigError and PlatformError are dependency failures. Shared parser CommandLineInvalid lies outside that union. Sync.Moved is consumed by replanning; exhaustion produces Sync.Unsettled. History StoreMissing, StoreCorrupt and StoreFailed can be wrapped by AuthorHistoryInvalid. Protocol invariant failures are defects, not ordinary user refusals.",
    source: "packages/cli/src/author/commands.ts",
  },
];
