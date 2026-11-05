/**
 * Owner boundaries, checked by lint (skit/owner-boundaries). Generated from app.ts's Library,
 * InstalledSkills, AuthorWorkspace and AuthorHistory owners; edit app.ts and this file together,
 * in a reviewed architecture change.
 *
 * `sources`: modules whose exports carry the owner's private names (default: core). AuthorWorkspace
 * and AuthorHistory are checked by architecture/conformance/author.ts, as library.ts is checked.
 *
 * `private`: names only code under `owner` may import. Every caller is checked; there are no
 * per-file migration exemptions. Package-local tests may exercise private modules, but may not
 * import private names through compatibility APIs.
 */
export const owners = [
  {
    name: "Identity",
    owner: "packages/skit-server-effect/src/identity/",
    privateModules: ["packages/skit-server-effect/src/identity/internal/"],
    testOwner: "packages/skit-server-effect/test/",
    private: [],
  },
  {
    name: "ServerLibrary",
    owner: "packages/skit-server-effect/src/library/",
    privateModules: ["packages/skit-server-effect/src/library/internal/"],
    testOwner: "packages/skit-server-effect/test/",
    private: [],
  },
  {
    name: "Skits",
    owner: "packages/skit-server-effect/src/skits/",
    privateModules: ["packages/skit-server-effect/src/skits/internal/"],
    testOwner: "packages/skit-server-effect/test/",
    private: [],
  },
  {
    name: "Library",
    owner: "packages/skit/src/library/",
    // Storage and recovery implementation modules belong to Library, whatever they export.
    privateModules: [
      "packages/skit/src/library/store/library-store.",
      "packages/skit/src/library/store/state-file.",
      "packages/skit/src/library/store/writer-lock.",
      "packages/skit/src/library/store/step-error-compat.",
      "packages/skit/src/library/internal/",
    ],
    testOwner: "packages/skit/test/",
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
    name: "InstalledSkills marker compatibility",
    owner: "packages/skit/src/installed-skills/",
    privateModules: ["packages/skit/src/installed-skills/ownership-marker-compat."],
    testOwner: "packages/skit/test/",
    private: ["StoredOwnershipMarker"],
  },
  {
    name: "Registry credentials",
    owner: "packages/cli/src/registry/",
    privateModules: [
      "packages/cli/src/registry/auth.",
      "packages/cli/src/registry/credential-store.",
    ],
    testOwner: "packages/cli/test/",
    sources: ["packages/cli/src/registry/"],
    private: [
      "resolveAuth",
      "resolveAuthForOrigin",
      "readStoredToken",
      "writeStoredToken",
      "removeStoredToken",
    ],
  },
  {
    // NEW owner (architecture/author.ts). Callers use AuthorWorkspace and its lease; this export
    // serves the owner itself.
    name: "AuthorWorkspace",
    owner: "packages/skit/src/author/",
    privateModules: ["packages/skit/src/author/local-tree."],
    testOwner: "packages/skit/test/",
    sources: ["packages/skit/src/author/"],
    private: ["writeWorkspaceTree"],
  },
  {
    // RESHAPE owner (architecture/author.ts): history, its journal and the history store.
    // Callers use AuthorHistory; these exports serve the owner itself.
    name: "AuthorHistory",
    owner: "packages/skit/src/author/history",
    sources: ["packages/skit/src/author/"],
    private: ["makeHistoryStore", "storedPath"],
  },
];

/** Only the services approved by the ownership model may be declared. No migration exemptions. */
export const approvedServices = [
  "skit/library/Library",
  // Present only inside writeLibrary, which holds the home lock: the capability to save state.
  "skit/library/LibraryWriter",
  // Private scoped capability over HomeLock's OS lock; nested leases drain before release.
  "skit/platform/HomeLockLease",
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
  "@skit-server-effect/ServerLibrary",
  "@skit-server-effect/Teams",
  "@skit-server-effect/Feedback",
  "@skit-server-effect/Identity",
  "@skit-server-effect/ServerConfiguration",
  "skit/AuthorIgnoreRepository",
  "skit/author/AuthorWorkspace",
  "skit/author/AuthorHistory",
];
