/**
 * Owner boundaries, checked by lint (skit/owner-boundaries). Generated from app.ts's Library,
 * InstalledSkills, AuthorWorkspace and AuthorHistory owners; edit app.ts and this file together,
 * in a reviewed architecture change.
 *
 * `sources`: modules whose exports carry the owner's private names (default: core). AuthorWorkspace
 * and AuthorHistory are checked by architecture/conformance/author.ts, as library.ts is checked.
 *
 * `private`: names only code under `owner` may import. `debt`: today's violations, NOT approved.
 * The debt list may only shrink: lint/owner-boundaries.test.ts fails on a stale entry, and the
 * rule fails on any import not listed here.
 */
export const owners = [
  {
    name: "Library",
    owner: "packages/skit/src/library/",
    // Storage and recovery implementation modules belong to Library, whatever they export.
    privateModules: [
      "packages/skit/src/library/store/library-store.",
      "packages/skit/src/library/store/state-file.",
      "packages/skit/src/library/store/writer-lock.",
      "packages/skit/src/library/internal/",
    ],
    testOwner: "packages/skit/test/",
    // The barrel re-exports these today; that export is itself debt, removed as callers migrate.
    allow: ["packages/skit/src/index.ts"],
    private: [
      "prepareRecoveryMoves",
      "prepareOwnedRecoveryMoves",
      "prepareRecoveryRestore",
      "ensureRecoveryOperation",

      "withHomeLock",
      "InstalledSkillFiles",
      "InstalledSkillBackups",
      "writeCollectionVersion",
      "importCollection",
      "importEdit",
      "importAuthoredCollection",
      "prepareImport",
      "refreshLibraryInventory",
      "acceptSecurityFindingFromState",
      "prepareRestore",
      "keepInstalledSkillBackup",
      "backUpInstalledSkill",
      "commitInstalledSkill",
      "stageInstalledSkill",
    ],
  },
  {
    // The write gate: inside Library, only library/store/ reads or writes state.json, so every
    // change holds the home lock through `writeLibrary` and is recorded in Library history.
    name: "Library storage",
    owner: "packages/skit/src/library/store/",
    privateModules: ["packages/skit/src/library/store/state-file."],
    testOwner: "packages/skit/test/",
    private: [],
  },
  {
    // NEW owner (architecture/author.ts). Callers use AuthorWorkspace and its lease; this export
    // serves the owner itself.
    name: "AuthorWorkspace",
    owner: "packages/cli/src/author/",
    sources: ["packages/cli/src/author/"],
    private: ["writeWorkspaceTree"],
  },
  {
    // RESHAPE owner (architecture/author.ts): history, its journal and the history store.
    // Callers use AuthorHistory; these exports serve the owner itself.
    name: "AuthorHistory",
    owner: "packages/cli/src/author/history",
    sources: ["packages/cli/src/author/"],
    private: ["makeHistoryStore", "storedPath"],
  },
];

export const debt = {
  "packages/cli/test/pnpm-skills.test.ts": ["prepareRecoveryMoves"],
  "packages/cli/test/recovery-moves.test.ts": ["prepareRecoveryMoves", "prepareRecoveryRestore"],
  "packages/cli/test/recovery-command.test.ts": ["prepareRecoveryMoves"],
  "packages/cli/src/author/history.ts": ["withHomeLock"],
  "packages/cli/src/configuration-writer.ts": ["withHomeLock"],
  "packages/cli/src/handlers/library/recovery.ts": ["prepareRecoveryRestore"],
  "packages/cli/test/setup-undo.test.ts": ["prepareRecoveryMoves"],
  "packages/skit/test/collection-import-result.test.ts": [
    "importAuthoredCollection",
    "importCollection",
  ],
  "packages/skit/test/import-collection-errors.test.ts": ["prepareImport"],
  "packages/skit/test/library-binding-entries.test.ts": ["importCollection"],
  "packages/skit/test/library-history.test.ts": ["importCollection", "withHomeLock"],
  "packages/skit/test/library-installed-skills.test.ts": [
    "backUpInstalledSkill",
    "importCollection",
    "importEdit",
  ],
  "packages/skit/test/library-local-journey.test.ts": [
    "importCollection",
    "prepareRestore",
    "withHomeLock",
  ],
  "packages/skit/test/library-moved-skill.test.ts": ["importCollection"],
  "packages/skit/test/library-restore-content.test.ts": [
    "importCollection",
    "prepareRestore",
    "withHomeLock",
  ],
  "packages/skit/test/library-store.test.ts": ["importCollection"],
  "packages/skit/test/library-writer-lock.test.ts": ["withHomeLock"],
  "packages/skit/test/local-retention.test.ts": ["writeCollectionVersion"],
  "packages/skit/test/machine-settings.test.ts": ["withHomeLock"],
  "packages/skit/test/sources.test.ts": ["prepareImport"],
};

/**
 * Services the model approves (app.ts owners and platform). Any other Context.Service or
 * Context.Reference fails lint (skit/approved-services) unless listed in serviceDebt, which is
 * today's unapproved services with what replaces them. serviceDebt only shrinks.
 */
export const approvedServices = [
  "skit/library/Library",
  // Present only inside writeLibrary, which holds the home lock: the capability to save state.
  "skit/library/LibraryWriter",
  "skit/library/InstalledSkills",
  "skit/Renderer",
  "skit/Prompter",
  "skit/library/Progress",
  "skit/services/RegistryHttp",
  "skit/SkitConfiguration",
  "skit/LinkStat",
  "skit/SourceProcess",
  "@smolai/skit-core/CurrentPrincipal",
  "@skit-server-effect/BlobStore",
  "@skit-server-effect/Skits",
  "@skit-server-effect/Teams",
  "@skit-server-effect/Feedback",
  "@skit-server-effect/ServerConfiguration",
  "skit/AuthorIgnoreRepository",
  "skit/author/AuthorWorkspace",
  "skit/author/AuthorHistory",
];

export const serviceDebt = {
  "@smolai/skit/CurrentLibraryWriter": "becomes HomeLock",
  "skit/library/LibraryActor": "OPEN: history attribution; not in the model yet",
  "skit/artifact/TreeHasher": "plain function over Digest",
  "skit/SkillUsage": "plain scanUsage()",
  "skit/services/RegistryAuth": "becomes the Registry owner",
  "skit/ReleaseChecker": "plain functions (ReleaseNotice)",
  "@skit-server-effect/Authentication": "becomes Identity",
  "@skit-server-effect/BetterAuth": "becomes Identity",
  "@skit-server-effect/Bootstrap": "becomes Identity.createOperator",
  "@skit-server-effect/PasswordHasher": "plain function shared with Better Auth",
  "@skit-server-effect/AuthorInventory": "becomes Skits.list",
  "@skit-server-effect/Authorization": "becomes HttpApi middleware + owner checks",
  "@skit-server-effect/LibrarySync": "merges into ServerLibrary",
  "@skit-server-effect/LibrarySnapshots": "merges into ServerLibrary",
  "@skit-server-effect/NativeClock": "use Clock",
  "@skit-server-effect/NativeCrypto": "use SecureRandom + Digest",
  "@skit-server-effect/PatRateLimiter": "one RateLimiter shape",
  "@skit-server-effect/BootstrapRateLimiter": "one RateLimiter shape",
  "@skit-server-effect/FeedbackRateLimiter": "one RateLimiter shape",
  "@skit-server-effect/Publication": "folds into Skits",
  "@skit-server-effect/ReadinessInspector": "plain inspect()",
  "@skit-server-effect/ReleaseStore": "folds into Skits",
  "@skit-server-effect/SkitDeletion": "folds into Skits.delete",
  "test/ListingFixture": "test-only service; tests change, not the model",
  "test/NativeLibraryFixture": "test-only service; tests change, not the model",
};
