/**
 * Whole-app ownership model. Approved; enforced by lint (architecture/boundaries.mjs) and
 * conformance types (architecture/conformance/).
 *
 * Every piece of persisted state has exactly one owner. Nothing outside an owner may import that
 * owner's private modules. `removes` lists what stops existing when the owner exists: the subtraction
 * is the point. `ops` are public operation names; full signatures follow per owner once the graph
 * is approved (library.ts is the first). Open decisions are in decisions.md, keyed D1…; each
 * carries a recommendation with references.
 *
 * Status: EXISTS (today's boundary, keep), RESHAPE (exists, ownership changes), NEW.
 *
 * Service rule: a Context.Service exists only if it owns state, holds a resource, is a platform
 * boundary that a real second implementation replaces, or is a key the framework requires
 * (HttpApi middleware, command annotations). Test substitution is never the reason. Everything
 * else is a plain function. Workflows coordinate owners and are plain functions, never services.
 */

export const owners = {
  // ── Device (core + CLI) ────────────────────────────────────────────────────────────────────
  Library: {
    status: "RESHAPE",
    module: "packages/skit/src/library/**",
    owns: [
      "<home>/state.json (+ migration backups)",
      "<home>/originals/**",
      "<home>/variants/**",
      "<home>/audit.jsonl",
      "<home>/removed/** — backups, plus immutable move receipts written before the first move", // D4 (setup-recovery-refactor.md:26,43)
    ],
    ops: [
      "read: Snapshot (Absent | Present, each with a revision)", // D1
      "plan(intent, { base }) / apply(plan)",
      "import.{collection, authored, edit} (additive)",
      "setup(steps, { base }): saved before running; finishes or stops, never auto-rollback", // D4
      "content.{inspect, pack} for sync",
      "history",
    ],
    migrations: "once, during Library.layer construction, under the home lock; reads never write", // D2
    intents: [
      "Enable | Disable | Remove | Update | Install | Uninstall", // EXISTS
      "Undo | Restore | AcceptFinding | RefreshInventory | Manage", // D4: NEW intents
      "Sync(remote result, expected revision)", // decisions.md "Library sync owns no state"
    ],
    requires: ["InstalledSkills", "FileSystem", "Path", "LinkStat", "SourceProcess", "HomeLock"],
    layer:
      "Library.layer({ home, routing: None | Recorded | Configured }) — one constructor; keeps the 3 routing modes (library-owner.ts:4-17, library-sync-installed-skills.ts:310-313)",
    invariants: [
      "one composed action records one history event (ADR-0024:65)",
      "operation record is durable before the first folder move (setup-recovery-refactor.md:26)",
      "Setup intent carries prior/expected-after evidence in the same state.json write (setup-recovery-refactor.md:136-138)",
    ],
    removes: [
      "LibraryStore service → private functions inside Library (tests that counted saves through it are rewritten)",
      "LibraryStore.inspect, .home/.originalsPath/.variantsPath/.statePath fields",
      "withLibraryWriter, withLibraryWriterLock, lastSavedLibraryState exports",
      "LibraryAuditLog service (append never called; list → Library.history)",
      "CurrentLibraryAction / CurrentLibraryWriter as cross-module references",
      "exported importCollection/importEdit/importAuthoredCollection/prepareImport",
      "exported refreshLibraryInventory, acceptSecurityFindingFromState, prepareRestore",
      "exported writeCollectionVersion",
      "legacy v7/v9 schema exports (0 external users)",
      "localLibrary / recordedLibrary / 6 raw Library.make sites (routing modes move into Library.layer)",
      "setup-apply's LibraryStore substitution (setup-apply.ts:256)",
      "configuration-writer.ts (withConfigurationWriter)",
      "library/security.ts (two 3-line pass-throughs)",
      "library-application/{update,update-installed-skills,set-enabled}.ts pass-throughs",
      "calculateSetEnabled in set-enabled-request.ts ('Legacy text/option compatibility'); the rest of the file stays",
      "recovery-moves.ts / setup-operation.ts / setup-undo*.ts as separate writers",
    ],
  },

  InstalledSkills: {
    status: "EXISTS",
    module: "packages/skit/src/library/installed-skills*.ts + install/**",
    owns: [
      "<skills root>/<name>/** and .skit-ownership.json",
      "<root>/.skit-backups/**",
      "<root>/.skit-stage-*, .skit-write-check-*",
    ],
    ops: ["facts (any caller)", "operations (Library only)"],
    requires: ["FileSystem", "Path", "LinkStat", "SourceProcess", "Digest"],
    removes: [
      "InstalledSkillFiles / InstalledSkillBackups namespace exports",
      "exported writeRawAtomic/writeJsonAtomic/writeJsonExclusive/copyLocalTree/ensureSkillsDirectoryWritable",
      "CLI marker and folder writes (setup-undo-files.ts:95,101,376,406; recovery-moves.ts:315)",
      "inventory/refresh.ts calling keepInstalledSkillBackup directly → InstalledSkills.backups.keep after a verified successor (architecture.md:223)",
      "TreeHasher service (one impl; tests inject a failing hash — decisions.md: When something is a Context.Service)",
    ],
  },

  DeviceSettings: {
    status: "RESHAPE", // D3: today MachineSettings, borrowing the Library lock
    module: "packages/skit/src/library/machine-settings.ts",
    owns: ["<home>/machine.json"],
    ops: [
      "read",
      "identity (write-once link; no lock)",
      "updateDiscovery",
      "restoreDiscovery",
      "setRepositoryDecision",
    ],
    requires: ["FileSystem", "HomeLock"],
    removes: ["withLibraryStateReplacement borrowed from the Library store"],
  },

  Registry: {
    status: "NEW",
    module: "packages/cli/src/registry/**",
    owns: ["<home>/auth.json", "OS keychain items", "<home>/login-pending.json"],
    ops: [
      "remotes.{list, add, setDefault, remove}",
      "credentials(origin?)",
      "login: DeviceLogin states Pending | Approved | Expired",
      "logout",
      "status",
    ],
    requires: ["FileSystem", "ChildProcessSpawner", "RegistryHttp", "SkitConfiguration"],
    removes: [
      "RegistryAuth Context.Reference with a 'no access' default (hides a missing layer)",
      "exported resolveAuth / resolveAuthForOrigin (7 bypassing callers)",
      "credential-store.ts as a public module (private to Registry)",
      "borrowing the Library .lock via withConfigurationWriter (takes HomeLock instead)",
      "unlocked savePendingLogin/clearPendingLogin, orchestrated in handlers/auth/login.ts",
      "CLI.* command functions living inside registry/auth.ts",
    ],
  },

  AuthorWorkspace: {
    status: "NEW",
    module: "packages/cli/src/author/**",
    owns: [
      "<root>/.skit/workspace.json, .skit/.gitignore",
      "<root>/.skit/connection.json (device checkpoint, git-ignored) + <root>/skit.remote.json (committed, portable; ADR-0010, ADR-0011) — two files stay, one logical state", // decisions.md "The author connection is one state"
      "<root>/.skit/lock (workspace lease; A8), <root>/.skit/stage-* (writeTree staging; A13)",
      "workspace tree writes during sync",
    ],
    ops: [
      "root(input): WorkspaceRoot (canonical; A1)",
      "read: { identity, connection: Unconnected | Connecting | Connected { leftover } } (never writes)",
      "identity(root) (workspace.json only; for AuthorHistory, A10)",
      "acquire(root): scoped WorkspaceLease { register, transition, writeTree, releasedFor } (A8)",
    ],
    requires: [
      "FileSystem",
      "Path",
      "LinkStat",
      "SourceProcess",
      "AuthorIgnoreRepository",
      "Digest",
      "SecureRandom",
    ],
    invariants: [
      "every workspace write happens under the lease; lease before home lock before Library writer (A8)",
      "writeTree needs a PreparedWrite from AuthorHistory and fsyncs before success (A13)",
    ],
    removes: [
      "saveAuthorConnection / removeAuthorConnection / writeRemote as three APIs for one state",
      "loadAuthorRemote / loadAuthorConnection / loadAuthorSyncRemote as three loaders",
      "workflows/author/workspace-identity.ts as a separate module (its identity-only registration moves into register)",
      "LinkStat.removeEmptyDirectory (a delete on a stat service; 1 caller)",
      "Library as a requirement (A3: the workflow reads Library and passes adopt)",
      "writeAuthorTree's global-temp staging and unflushed renames (workflows/author/sync.ts:417-434)",
    ],
  },

  AuthorHistory: {
    status: "RESHAPE",
    module: "packages/cli/src/workflows/author/{history,history-journal,device-store,sync}.ts",
    owns: ["<home>/history/**", "<home>/sync-bindings.json"],
    ops: [
      "observe(root): { id, revision, treeHash }",
      "retain(tree)",
      "engineStore: History.Store adapter (immutable, content-addressed, idempotent writes; A7)",
      "syncState.{read, transition} keyed by { workspaceId, locator } (A5, A6)",
    ],
    // Runs no sync: the plain sync workflow drives Sync.run with engineStore and syncState (A7).
    requires: [
      "FileSystem",
      "Path",
      "LinkStat",
      "SourceProcess",
      "AuthorIgnoreRepository",
      "Digest",
      "SecureRandom",
      "HomeLock",
      "DeviceSettings (device identity)",
      "AuthorWorkspace (identity only; A10)",
    ],
    removes: [
      "LegacySyncStates v2 'drafts' and PreReleaseBindings in the workflow (sync.ts:99-110)",
      "skit.sync-bindings.v3 locator-only keys: rejected as invalid, no migration (author commands never shipped; A5)",
      "historyDirectory / withDeviceStore exports (replaced by observe, retain, engineStore; A7)",
      "Sync.Remote as a Context.Service (packages/skit/src/sync/sync.ts:95-124) → plain engine input built per command from the Registry client (A7)",
      "module-global journal semaphore (history-journal.ts:29) → per layer, one layer per home (A9)",
    ],
  },

  ReleaseNotice: {
    status: "RESHAPE",
    module: "packages/cli/src/releases/checker.ts",
    owns: ["$XDG_STATE_HOME/skit/releases-<registry>.json"],
    ops: ["check", "notice"],
    requires: ["FileSystem", "HttpClient", "SkitConfiguration"],
    removes: [
      "ReleaseChecker Context.Service (one impl, provided ad hoc in 2 handlers)",
      "direct XDG_STATE_HOME read",
    ],
  },

  // ── Server ─────────────────────────────────────────────────────────────────────────────────
  Identity: {
    status: "NEW",
    module: "packages/skit-server-effect/src/auth/**",
    // server_bootstrap stays: its singleton insert is the concurrency guard (docs/self-hosting.md:261).
    owns: [
      "user",
      "account",
      "session",
      "verification",
      "deviceCode",
      "principals",
      "namespaces",
      "server_operators",
      "server_bootstrap",
    ],
    ops: [
      "authenticate",
      "provision",
      "claimUsername",
      "createOperator",
      "tokens.{create, list, revoke}",
      "DESIGNED, NOT IMPLEMENTED: suspend, reinstate, invalidateCredentials (writes state, authorization_generation)", // decisions.md "One Identity owner"
    ],
    removes: [
      "auth/provisioning.ts helper written from two services",
      "Bootstrap as a separate writer: its atomic claim batch moves into Identity.createOperator unchanged (self-hosting.md:261,269)",
      "NativeClock service (one consumer; use Clock)",
      "nested runPromise in Better Auth hooks (the Promise boundary itself stays; keep the hook invariants at better-auth.ts:264,286,325)",
      "rateLimit table (Better Auth rate limiting disabled)",
      "Authentication.authenticatePat in the public API",
    ],
  },

  Teams: {
    status: "EXISTS",
    owns: ["teams", "team_memberships"],
    ops: ["create", "addMember", "removeMember"],
    removes: [
      "direct INSERT into namespaces (via Identity)",
      "private ownedTeam SQL (via Authorization)",
    ],
  },

  Skits: {
    status: "RESHAPE",
    module: "packages/skit-server-effect/src/skits/**",
    owns: [
      "skits",
      "revisions, revision_parents, revision_trees, revision_tree_entries",
      "releases (a published state of a revision)", // decisions.md "Skits owns the whole SKIT"
      "draft-blobs/**, releases/**.zip",
    ],
    ops: [
      "create",
      "current",
      "post",
      "move",
      "revision",
      "ancestors",
      "list",
      "publish",
      "release reads",
      "delete",
    ],
    removes: [
      "SkitDeletion service (writes 8 tables owned by others)",
      "Publication service + ReleaseStore service as separate owners of releases",
      "AuthorInventory service (cross-owner join → Skits.list)",
      "publication/archive.ts reading Skits' tables directly",
      "ReleaseStore.readArchive leaking R2ObjectBody (done: BlobStore returns bytes or a stream)",
      "releases.adopted_content_digest (no reader or writer)",
    ],
  },

  ServerLibrary: {
    status: "RESHAPE",
    module: "packages/skit-server-effect/src/library/**",
    owns: ["libraries", "library_revisions", "library_snapshots", "<library_id>/<digest> blobs"],
    ops: ["read", "write(expected, manifest)", "snapshots.{upload, download}"],
    removes: [
      "LibrarySnapshots and LibrarySync as two services both inserting libraries rows",
      "library/owner.ts findOwnedLibrary helper",
      "exported commitLibraryRevision (test-only)",
    ],
  },

  // decisions.md "No per-SKIT grants" (decided): resource_grants dropped; access is namespace owner or team member. HttpApi
  // middleware establishes principal + scope; each owner enforces access.
  AuthorizationMiddleware: {
    status: "RESHAPE",
    owns: [],
    ops: ["principal + scope for the matched route"],
    invariants: [
      "a session write (not GET/HEAD) must carry Origin = PUBLIC_APP_ORIGIN; checked once, in the middleware (done)",
    ],
    removes: [
      "per-handler origin checks (done: 9 copies and credentialOriginAllowed removed)",
      "resource_grants table, its indexes and every grant query (decisions.md: No per-SKIT grants)",
      "Authorization service and its 7 single-caller can*/has*/scope methods",
      "authorization checks split between handlers and services",
      "Readiness.isServerOperator and Teams' private ownedTeam SQL",
    ],
  },

  Feedback: { status: "EXISTS", owns: ["feedback"], ops: ["record"], removes: [] },
} as const;

/** Workflows: plain functions that coordinate owners. They own no state and are not services. */
export const workflows = {
  LibrarySync: {
    status: "RESHAPE",
    module: "packages/cli/src/workflows/library/library-sync*.ts",
    owns: [], // decisions.md "Library sync owns no state": owns no state; local writes are Library.apply(Sync)
    ops: ["sync(origin)"],
    requires: ["Library", "Registry", "RegistryHttp", "HomeLock"],
    invariants: [
      "holds the home lock for the whole applying sync, reentrantly, as documented (library-sync-outcomes.md:111)",
    ],
    removes: [
      "3 direct LibraryStore.save sites (library-sync.ts:132,238; library-sync-installed-skills.ts:434)",
      "its own InstalledSkills construction (library-sync-installed-skills.ts:323)",
      "exists()+load() race: compares revisions from single reads",
    ],
  },
} as const;

/** Platform services, each kept under the service rule above (not every entry is re-checked yet). */
export const platform = [
  "HomeLock (one exclusive lock per <home>, reentrant with leases as WriterAuthority is today: writer-lock.ts:9-13,133-135)", // D3
  "AuthorIgnoreRepository (runtime-scoped resource; author-sync-testing.md:1117-1135)",

  "Renderer",
  "Prompter (second real implementation: the storybook journey recorder, presentation/interaction-recorder.ts)",
  "LibraryProgress (Context.Reference, silent by default; front ends provide a reporter)",
  "RegistryHttp",
  "SkitConfiguration",
  "CommandMetadata",
  "LinkStat",
  "SourceProcess",
  "History.Store",
  "CurrentPrincipal",
  "BlobStore (R2 port: get, stream, put, exists, delete, probe)",
  "D1Client",
] as const;

/** Removed outright or demoted to plain functions: no owner, no state, no resource. */
export const removedServices = [
  "SkillUsage → scanUsage()",
  "SetupDiscovery → plain function (the scan-once requirement is proven another way)",
  "PasswordHasher → plain function shared by Better Auth and bootstrap (same format: self-hosting.md:267)",
  "NativeCrypto → SecureRandom + Digest",
  "Pat/Bootstrap/FeedbackRateLimiter tags → one RateLimiter shape, auth included; bindings stay separate (self-hosting.md:119,257)",
  "ReadinessInspector → plain inspect()",
  "CurrentRequest → handlers read HttpServerRequest directly",
  "BootstrapOperations → plain functions over ChildProcessSpawner, RegistryHttp and SecureRandom",
  "server re-export shims (api/bootstrap.ts, api/errors.ts, bootstrap/contracts.ts); auth/contracts.ts's own types (CreatePatInput …) move, not deleted",
] as const;

/** Deleted commands (decisions.md "Unwired commands"): never wired since the initial public release. */
export const removedCommands = [
  "audit command (handlers/audit.ts only; audit/local.ts stays: the TUI is built on it)",
  "harness probe (handlers/harness/probe.ts)",
] as const;

/** Composition: one boundary layer per process; handlers yield owners and nothing else. */
export const entries = {
  cli: "main.ts provides platform once; one helper builds owner layers per command from flags (--home)", // decisions.md "Wiring"
  tui: "same boundary layer; imports only Library + session API, not CLI source paths",
  server: "applicationLayers: one provider site per service",
  removes: [
    "handlePlatform/Library/Registry/SourceCommand wrappers + per-handler skitConfigurationLayer",
    "selectedHome plumbing in ~20 handlers",
    "ad hoc registryHttpLayer() / releaseCheckerLive in handlers",
    "front-end.ts re-exporting libraryStoreLayer and skitLayer",
    "duplicate ReleaseStore and ServerConfiguration provides",
  ],
} as const;

/** Docs that describe today's mechanism and change with the removals above. */
export const docsToUpdate = [
  "docs/architecture.md:186 (LibraryStore as the CLI boundary), :223, :326 (publication compensation), :335 (grants), :383-389 (audit command)",
  "docs/self-hosting.md:282 (resource grants)",
  "docs/adr/0024 :92, :118 (withConfigurationWriter, root writer)",
  "docs/setup-apply-outcomes.md :19, :31 (withLibraryWriter)",
  "docs/setup-recovery-refactor.md :136-138 (setup-apply wraps publications)",
  "docs/library-sync-outcomes.md :22, :111, :193 (LibraryStore.publish counting, lock held across sync)",
  "docs/pnpm-managed-skills.md:17 (setup and audit share a cache)",
] as const;
