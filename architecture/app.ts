/**
 * Whole-app ownership model. Approved; enforced by lint (architecture/boundaries.mjs) and
 * conformance types (architecture/conformance/). Existing violations fail those checks directly;
 * migration debt never authorizes a service, API difference, file placement or import.
 * Target folder layout: architecture/layout.mjs (Arc work_01m6jatvy5f21a7x5q214td7a3).
 * CLI setup and enable use public library/setup.ts and library/enable.ts entries; their
 * private command interaction, output definitions and presentation live in the matching folders.
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
      "content.{plan, inspect, pack, stage} for sync",
      "history",
      "recovery.{list, inspect} (passive, independent of audit-log validity)",
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
      "home-lock contention is HomeBusy across all home owners; old recorded LibraryBusy failures decode privately",
      "operation record is durable before the first folder move (setup-recovery-refactor.md:26)",
      "Setup intent carries prior/expected-after evidence in the same state.json write (setup-recovery-refactor.md:136-138)",
    ],
    removes: [
      "LibraryStore service → private functions inside Library (tests that counted saves through it are rewritten)",
      "LibraryStore.inspect, .home/.originalsPath/.variantsPath/.statePath fields",
      "withLibraryWriter / lastSavedLibraryState exports; withHomeLock export removed (shared HomeLock grants no writer)",
      "CurrentLibraryAction / CurrentLibraryWriter as cross-module references (removed; HomeLock provides its private scoped HomeLockLease capability)",
      "LibraryActor reference (removed; front ends annotate skit.library.workflow through Effect log annotations)",
      "exported importCollection/importEdit/importAuthoredCollection/prepareImport",
      "exported refreshLibraryInventory, acceptSecurityFindingFromState, prepareRestore",
      "exported writeCollectionVersion",
      "legacy v7/v9 schema exports (0 external users)",
      "root contracts.ts/vocabulary.ts/schemas.ts/failures.ts (removed; canonical declarations live with their owners)",
      "localLibrary / recordedLibrary / 6 raw Library.make sites (routing modes move into Library.layer)",
      "setup-apply's LibraryStore substitution (done: setup-apply builds SetupStep[] and calls Library.setup)",
      "configuration-writer.ts (removed; Registry auth owns its write under HomeLock.withLock)",
      "library/security.ts (two 3-line pass-throughs)",
      "library-application/{update,update-installed-skills,set-enabled}.ts pass-throughs",
      "calculateSetEnabled in set-enabled-request.ts ('Legacy text/option compatibility'); the rest of the file stays",
      "public recovery restore/move callbacks (compatibility exports; setup undo now uses Library.plan/apply)",
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
      "StoredOwnershipMarker public migration schema (private installed-skills compatibility boundary)",
      "exported writeRawAtomic/writeJsonAtomic/writeJsonExclusive/copyLocalTree/ensureSkillsDirectoryWritable",
      "inventory/refresh.ts calling keepInstalledSkillBackup directly → InstalledSkills.backups.keep after a verified successor (architecture.md:223)",
      "TreeHasher service (one impl; tests inject a failing hash — decisions.md: When something is a Context.Service)",
    ],
  },

  MachineSettings: {
    status: "RESHAPE", // D3: plain functions today, borrowing the Library lock
    module: "packages/skit/src/library/machine-settings.ts",
    owns: ["<home>/machine.json"],
    ops: [
      "read",
      "identity (write-once link; no lock)",
      "updateDiscovery",
      "restoreDiscovery",
      "planRestoreDiscovery / applyRestoreDiscovery (reviewed setup inverse; completion in machine.json)",
      "restoreSetupDiscovery (by operation id)",
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
      "RegistryAuth Context.Reference with a 'no access' default (removed; Registry.credentials/source are plain owner operations over required configuration)",
      "exported resolveAuth / resolveAuthForOrigin (7 bypassing callers)",
      "credential-store.ts as a public module (private to Registry)",
      "borrowing the Library lock via withConfigurationWriter (removed; takes HomeLock.withLock)",
      "unlocked savePendingLogin/clearPendingLogin, orchestrated in handlers/auth/login.ts",
      "CLI.* command functions living inside registry/auth.ts",
    ],
  },

  AuthorWorkspace: {
    status: "NEW",
    module: "packages/skit/src/author/**",
    owns: [
      "<root>/.skit/workspace.json, .skit/.gitignore",
      "<root>/.skit/connection.json (device checkpoint, git-ignored) + <root>/skit.remote.json (committed, portable; ADR-0010, ADR-0011) — two files stay, one logical state", // decisions.md "The author connection is one state"
      "<root>/.skit/lock (workspace lease; A8), <root>/.skit/stage-* (writeTree staging; A13)",
      "workspace tree writes during sync",
    ],
    ops: [
      "resolveRoot(input): WorkspaceRoot (canonical; A1)",
      "read: { identity, connection: Unconnected | Connecting | Connected { leftover } } (never writes)",
      "readIdentity(root) (workspace.json only; for AuthorHistory, A10)",
      "acquire(root): scoped WorkspaceLease { register, transition, writeTree } (A8)",
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
    module: "packages/skit/src/author/{history,history-store}.ts",
    owns: ["<home>/history/**", "<home>/sync-bindings.json"],
    ops: [
      "capture(root): { id, revision, treeHash }",
      "retain(tree)",
      "engineStore: History.Store adapter (immutable, content-addressed, idempotent writes; A7)",
      "syncState.{read, save, prepareWrite} keyed by { workspaceId, locator } (A5, A6)",
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
      "MachineSettings (device identity)",
      "AuthorWorkspace (identity only; A10)",
    ],
    removes: [
      "LegacySyncStates v2 'drafts' and PreReleaseBindings in the workflow (sync.ts:99-110)",
      "skit.sync-bindings.v3 locator-only keys: rejected as invalid, no migration (author commands never shipped; A5)",
      "historyDirectory / withDeviceStore exports (replaced by capture, retain, engineStore; A7)",
      "module-global journal semaphore (history-journal.ts:29) → per layer, one layer per home (A9)",
    ],
  },

  ReleaseNotice: {
    status: "EXISTS",
    module: "packages/cli/src/releases.ts",
    owns: ["$XDG_STATE_HOME/skit/releases-<registry>.json"],
    ops: ["checkRelease", "noticeRelease"],
    requires: ["FileSystem", "HttpClient", "SkitConfiguration"],
    removes: [
      "ReleaseChecker Context.Service (done: callers use plain owner functions)",
      "direct XDG_STATE_HOME read (done: uses SkitConfiguration.stateHome)",
    ],
  },

  // ── Server ─────────────────────────────────────────────────────────────────────────────────
  Identity: {
    status: "RESHAPE",
    module: "packages/skit-server-effect/src/identity/**",
    // server_bootstrap stays: its singleton insert is the concurrency guard (docs/self-hosting.md:261).
    owns: [
      "user",
      "account",
      "session",
      "verification",
      "deviceCode",
      "personal_access_tokens",
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
      "Authentication and BetterAuth providers (done: one Identity provider owns both implementations)",
      "shared provisioning helper outside Identity (done: private to Identity's SDK and bootstrap implementations)",
      "Bootstrap as a separate writer (done: Identity.createOperator owns the unchanged atomic claim batch and post-commit verification email)",
      "NativeClock service (done: Better Auth captures the built-in Clock)",
      "nested runPromise in Better Auth hooks (the Promise boundary itself stays; keep the hook invariants at better-auth.ts:264,286,325)",
      "rateLimit table (Better Auth rate limiting disabled)",
      "Authentication.authenticatePat in the public API (done: private to Identity credential implementation)",
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
      "SkitDeletion service (done: planDelete/delete are Skits operations; implementation private under skits/internal)",
      "Publication + ReleaseStore services (done: Skits.publish and Skits.releases own release writes and reads)",
      "AuthorInventory service (done: access-filtered query is Skits.list; no separate tag/provider)",
      "publication/archive.ts reading Skits' tables directly (done: private skits/internal/release-archive.ts)",
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
      "LibrarySnapshots + LibrarySync services (done: one ServerLibrary constructor and default-Library lookup)",
      "library/owner.ts helper (done: private internal/owned.ts, used only by ServerLibrary construction)",
      "public commitLibraryRevision export (done: private internal/sync.ts; only the owner and an atomic-guard unit test use it)",
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
      "Readiness.isServerOperator (done: auth owns operator lookup); Teams' private ownedTeam SQL",
    ],
  },

  Feedback: { status: "EXISTS", owns: ["feedback"], ops: ["record"], removes: [] },
} as const;

/**
 * Every core subpath is an owner API or an explicitly approved shared API. Shared describes
 * responsibility, not purity: harness probes can run processes but own no persisted SKIT state.
 * These declarations do not prove implementation behavior; existing owner/import boundaries
 * and universal-entry checks still apply. Both kinds require exact source/conditional targets.
 * The root export is an aggregate compatibility surface, not a subpath.
 */
export const coreExports = {
  "./library": { kind: "owner", owners: ["Library"], source: "packages/skit/src/library/index.ts" },
  "./library/routing": {
    kind: "owner",
    owners: ["Library"],
    source: "packages/skit/src/library/routing/index.ts",
  },
  "./library/setup": {
    kind: "owner",
    owners: ["Library"],
    source: "packages/skit/src/library/setup.ts",
  },
  "./library/session": {
    kind: "owner",
    owners: ["Library"],
    source: "packages/skit/src/library/session.ts",
  },
  "./author": {
    kind: "owner",
    owners: ["AuthorWorkspace", "AuthorHistory"],
    source: "packages/skit/src/author/index.ts",
  },
  "./harnesses": {
    kind: "shared",
    purpose:
      "Harness metadata, detection and caller-scoped process probes; owns no persisted SKIT state.",
    source: "packages/skit/src/harnesses/index.ts",
  },
  "./audit": {
    kind: "shared",
    purpose: "Passive local capability scans and versioned audit report schemas.",
    source: "packages/skit/src/auditing/index.ts",
  },
  "./universal/consumer": {
    kind: "shared",
    purpose:
      "Runtime-neutral consumer contracts and artifact behavior shared by device and Registry.",
    source: "packages/skit/src/universal-consumer.ts",
  },
  "./universal/authoring": {
    kind: "shared",
    purpose:
      "Runtime-neutral authoring/publication protocols and history algorithms over the consumer surface.",
    source: "packages/skit/src/universal-authoring.ts",
  },
  "./universal/api": {
    kind: "shared",
    purpose: "Shared HTTP endpoint definitions, middleware contracts and domain schemas.",
    source: "packages/skit/src/api/index.ts",
  },
} as const satisfies {
  [subpath: string]: { source: string } & (
    | { kind: "owner"; owners: readonly [keyof typeof owners, ...(keyof typeof owners)[]] }
    | { kind: "shared"; purpose: string }
  );
};

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

/**
 * Plain platform functions (not services, under the service rule): acquireFileLock (A8) and
 * the home lock, one exclusive lock per <home>, reentrant with leases as WriterAuthority is today
 * (writer-lock.ts:7-12,126-128; D3), a plain Effect.fn as t3code's directory lock is. Across processes
 * the home lock is acquireFileLock on <home>/lock.sqlite, which the OS releases on crash.
 */
/** Platform services, each kept under the service rule above (not every entry is re-checked yet). */
export const platform = [
  "AuthorIgnoreRepository (runtime-scoped resource; author-sync-testing.md:1117-1135)",

  "Renderer",
  "Prompter (second real implementation: the storybook journey recorder, storybook/interaction-recorder.ts)",
  "LibraryProgress (Context.Reference, silent by default; front ends provide a reporter)",
  "RegistryHttp",
  "SkitConfiguration",
  "CommandMetadata",
  "LinkStat",
  "SourceProcess",
  "CurrentPrincipal",
  "BlobStore (R2 port: get, stream, put, exists, delete, probe)",
  "D1Client",
] as const;

/** Removed outright or demoted to plain functions: no owner, no state, no resource. */
export const removedServices = [
  "Sync.Remote → plain engine input to Sync.loadPlanInput / Sync.run, built per command from the Registry client (A7)",
  "History.Store → plain engine input to Sync and History.record; one implementation, the CLI device store (AuthorHistory.engineStore)",
  "SkillUsage → scanUsage()",
  "SetupDiscovery → plain function (the scan-once requirement is proven another way)",
  "PasswordHasher → plain functions shared by Better Auth and bootstrap (done; same format: self-hosting.md:267)",
  "NativeCrypto → SecureRandom + Digest; built-in WebCrypto reference only for Promise password callbacks (done)",
  "Pat/Bootstrap/FeedbackRateLimiter tags → one plain RateLimiter shape, auth included (done); bindings stay separate (self-hosting.md:119,257)",
  "ReadinessInspector → plain platform inspectReadiness() (done)",
  "CurrentRequest → handlers read HttpServerRequest directly",
  "BootstrapOperations → plain functions over ChildProcessSpawner, RegistryHttp and SecureRandom",
  "server re-export shims (api/bootstrap.ts, api/errors.ts, bootstrap/contracts.ts); auth/contracts.ts's own types (CreatePatInput …) move, not deleted",
] as const;

/** Deleted commands (decisions.md "Unwired commands"): never wired since the initial public release. */
export const removedCommands = [
  "audit command stays in CLI; shared audit reads and schemas live in core/auditing for CLI and TUI",
  "harness probe command (handlers/harness/probe.ts); reusable probes live in core harnesses/",
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
  "docs/setup-recovery-refactor.md :136-138 (setup-apply wraps publications)",
  "docs/library-sync-outcomes.md :22, :111, :193 (LibraryStore.publish counting, lock held across sync)",
  "docs/pnpm-managed-skills.md:17 (setup and audit share a cache)",
] as const;
