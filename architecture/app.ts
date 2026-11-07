/**
 * Owner navigation and the core package export contract.
 *
 * The structure checker uses owner identities and coreExports; lint also uses coreExports.
 * Module and state descriptions are navigation, not a checked service graph or API contract.
 * Private imports, permitted services and placement are enforced by boundaries.mjs/layout.mjs.
 * Selected API signatures are checked by conformance/; see README.md for coverage.
 * Durable rationale belongs in docs/adr/; migration plans and progress belong in Arc Work.
 */

export const owners = {
  Library: {
    module: "packages/skit/src/library/**",
    owns: [
      "<home>/state.json (+ migration backups)",
      "<home>/originals/**",
      "<home>/variants/**",
      "<home>/audit.jsonl",
      "<home>/removed/** — backups, plus immutable move receipts written before the first move",
    ],
  },
  InstalledSkills: {
    module: "packages/skit/src/library/installed-skills.ts + packages/skit/src/installed-skills/**",
    owns: [
      "<skills root>/<name>/** and .skit-ownership.json",
      "<root>/.skit-backups/**",
      "<root>/.skit-stage-*, .skit-write-check-*",
    ],
  },
  MachineSettings: {
    module: "packages/skit/src/library/machine-settings.ts",
    owns: ["<home>/machine.json"],
  },
  Registry: {
    module: "packages/cli/src/registry/**",
    owns: ["<home>/auth.json", "OS keychain items", "<home>/login-pending.json"],
  },
  AuthorWorkspace: {
    module: "packages/skit/src/author/**",
    owns: [
      "<root>/.skit/workspace.json, .skit/.gitignore",
      "<root>/.skit/connection.json (device checkpoint) and <root>/skit.remote.json (portable connection)",
      "<root>/.skit/lock.sqlite (workspace lease), <root>/.skit/stage-* (writeTree staging)",
      "workspace tree writes during sync",
    ],
  },
  AuthorHistory: {
    module: "packages/skit/src/author/{history,history-store}.ts",
    owns: ["<home>/history/**", "<home>/author-sync.json"],
  },
  ReleaseNotice: {
    module: "packages/cli/src/releases.ts",
    owns: ["$XDG_STATE_HOME/skit/releases-<registry>.json"],
  },
  Identity: {
    module: "packages/skit-server-effect/src/identity/**",
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
  },
  Teams: {
    owns: ["teams", "team_memberships"],
  },
  Skits: {
    module: "packages/skit-server-effect/src/skits/**",
    owns: [
      "skits",
      "revisions, revision_parents, revision_trees, revision_tree_entries",
      "releases (a published state of a revision)",
      "draft-blobs/**, releases/**.zip",
    ],
  },
  ServerLibrary: {
    module: "packages/skit-server-effect/src/library/**",
    owns: ["libraries", "library_revisions", "library_snapshots", "<library_id>/<digest> blobs"],
  },
  AuthorizationMiddleware: {
    owns: [],
  },
  Feedback: {
    owns: ["feedback"],
  },
} as const;

/**
 * Every core subpath is an owner API or an explicitly approved shared API. Shared describes
 * responsibility, not purity: harness probes can run processes but own no persisted SKIT state.
 * These declarations do not prove implementation behavior; existing owner/import boundaries
 * and universal-entry checks still apply. Both kinds require exact source/conditional targets.
 * Core has no root entry; callers choose one of these owner or shared subpaths.
 */
export const coreExports = {
  "./platform/home-lock": {
    kind: "shared",
    purpose:
      "Same-home serialization for Library, MachineSettings, AuthorHistory and Registry owners; grants no owner writer access.",
    source: "packages/skit/src/platform/home-lock.ts",
  },
  "./machine-settings": {
    kind: "owner",
    owners: ["MachineSettings"],
    source: "packages/skit/src/library/machine-settings.ts",
  },
  "./library/source": {
    kind: "owner",
    owners: ["Library"],
    source: "packages/skit/src/library/source.ts",
  },
  "./history": {
    kind: "shared",
    purpose: "Content-addressed trees, revisions and store protocol shared by Author and Library.",
    source: "packages/skit/src/history/history.ts",
  },
  "./library/inventory": {
    kind: "owner",
    owners: ["Library"],
    source: "packages/skit/src/library/inventory.ts",
  },
  "./library/usage": {
    kind: "owner",
    owners: ["Library"],
    source: "packages/skit/src/library/usage.ts",
  },
  "./shared": {
    kind: "shared",
    purpose:
      "Common failure, hash, JSON and build vocabulary without persisted owner state or Node runtime wiring.",
    source: "packages/skit/src/shared/index.ts",
  },
  "./platform": {
    kind: "shared",
    purpose:
      "Device configuration snapshots and runtime/process/path adapters; no owner stores or writer capabilities.",
    source: "packages/skit/src/platform/index.ts",
  },
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
  "./library/enable": {
    kind: "owner",
    owners: ["Library"],
    source: "packages/skit/src/library/enable.ts",
  },
  "./library/queries": {
    kind: "owner",
    owners: ["Library"],
    source: "packages/skit/src/library/queries.ts",
  },
  "./library/edit": {
    kind: "owner",
    owners: ["Library"],
    source: "packages/skit/src/library/edit.ts",
  },
  "./library/update": {
    kind: "owner",
    owners: ["Library"],
    source: "packages/skit/src/library/update.ts",
  },
  "./library/sync": {
    kind: "owner",
    owners: ["Library"],
    source: "packages/skit/src/library/sync.ts",
  },
  "./library/recovery": {
    kind: "owner",
    owners: ["Library"],
    source: "packages/skit/src/library/recovery.ts",
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
      "Harness catalog, detection, listing budgets from inventory reports and caller-scoped process probes; owns no persisted SKIT state.",
    source: "packages/skit/src/harnesses/index.ts",
  },
  "./audit": {
    kind: "shared",
    purpose:
      "Passive local capability scans, Skill security assessment and versioned report schemas.",
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
  "./api": {
    kind: "shared",
    purpose: "HTTP endpoint definitions, middleware contracts and domain schemas.",
    source: "packages/skit/src/api/index.ts",
  },
} as const satisfies {
  [subpath: string]: { source: string } & (
    | { kind: "owner"; owners: readonly [keyof typeof owners, ...(keyof typeof owners)[]] }
    | { kind: "shared"; purpose: string }
  );
};
