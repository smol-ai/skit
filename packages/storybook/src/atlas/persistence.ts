import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { atlasProgram, inspectErrors } from "./errors.ts";
import type { ErrorDefinition, PersistedStore } from "./data.ts";

type Source = string | { readonly file: string; readonly names: readonly string[] };
interface Store {
  readonly id: string;
  readonly name: string;
  readonly scope: "Device" | "Workspace" | "Registry";
  readonly format: string;
  readonly paths: readonly string[];
  readonly owner: string;
  readonly owners: readonly { readonly file: string; readonly names: readonly string[] }[];
  readonly description: string;
  readonly sources: readonly Source[];
}
const core = (file: string) => `packages/skit/src/${file}.ts`;
const selected = (file: string, ...names: string[]): Source => ({ file: core(file), names });

/** Paths and ownership need explanation; definitions are read from the current checkout. */
const stores: readonly Store[] = [
  {
    id: "library-state",
    name: "Library state",
    scope: "Device",
    format: "SQLite",
    paths: [
      "<home>/library.sqlite",
      "<home>/state.json",
      "<home>/state.json.v<version>.backup-database",
    ],
    owner: "Library store",
    owners: [
      {
        file: "packages/skit/src/library/store/library-store.ts",
        names: ["loadLibrary", "writeLibrary"],
      },
    ],
    description:
      "SQLite tables hold collections, skills, imports, installation records, sync ancestry and device-local Draft selections. A released state.json is imported once, kept as a backup, and left as a newer-version stub that older CLIs refuse.",
    sources: [
      core("library/store/database"),
      core("library/store/tables"),
      core("library/store/state-schema"),
      core("library/store/operations"),
      core("library/library-state"),
      core("library/device-state"),
    ],
  },
  {
    id: "machine",
    name: "Machine settings",
    scope: "Device",
    format: "SQLite",
    paths: ["<home>/library.sqlite", "<home>/machine.json"],
    owner: "MachineSettings",
    owners: [
      {
        file: "packages/skit/src/library/machine-settings.ts",
        names: ["read", "updateDiscovery", "setRepositoryDecision"],
      },
    ],
    description:
      "Device identity, discovery roots, repository decisions and setup undo evidence. Released machine.json settings are imported into the shared database.",
    sources: [core("library/store/machine-rows"), core("library/machine-document")],
  },
  {
    id: "library-audit",
    name: "Library audit history",
    scope: "Device",
    format: "SQLite",
    paths: ["<home>/library.sqlite", "<home>/audit.jsonl.backup-database"],
    owner: "Library audit log",
    owners: [
      {
        file: "packages/skit/src/library/audit/audit-log.ts",
        names: ["readLibraryAudit"],
      },
      {
        file: "packages/skit/src/library/store/state-file.ts",
        names: ["saveLibraryHistory"],
      },
    ],
    description:
      "One encoded LibraryAuditEvent per row, saved in the same transaction as the Library change it describes. A released audit.jsonl is imported once and kept as a backup.",
    sources: [core("library/audit/contracts")],
  },
  {
    id: "collection-files",
    name: "Collection Versions and variants",
    scope: "Device",
    format: "File trees",
    paths: [
      "<home>/originals/<hash-prefix>/<hash>/",
      "<home>/originals/compositions/trees/<hash>.json",
      "<home>/originals/compositions/blobs/<hash>",
      "<home>/variants/",
    ],
    owner: "Library content",
    owners: [
      {
        file: "packages/skit/src/library/internal/content/collection-version.ts",
        names: ["writeCollectionVersion"],
      },
      {
        file: "packages/skit/src/library/internal/content/read-collection-version.ts",
        names: ["readCollectionVersion"],
      },
      { file: "packages/skit/src/installed-skills/files.ts", names: ["keepInstalledSkillVariant"] },
    ],
    description:
      "Immutable imported originals, composition manifests with shared file blobs, and derived content. Original paths use the first two hash characters and the full hash without sha256:. Files retain their content and modes.",
    sources: [
      core("library/collection-version"),
      core("library/internal/content/collection-version"),
      core("library/internal/content/read-collection-version"),
    ],
  },
  {
    id: "author-journal",
    name: "Author history SQLite",
    scope: "Device",
    format: "SQLite",
    paths: ["<home>/library.sqlite"],
    owner: "AuthorHistory",
    owners: [{ file: "packages/skit/src/author/history.ts", names: ["AuthorHistory"] }],
    description:
      "Workspace identities and ordered revision events are stored in the shared device database.",
    sources: [selected("author/history-tables", "createAuthorHistoryTables")],
  },
  {
    id: "author-objects",
    name: "Author trees, revisions and blobs",
    scope: "Device",
    format: "SQLite and binary files",
    paths: ["<home>/library.sqlite", "<home>/file-bytes/"],
    owner: "AuthorHistory",
    owners: [{ file: "packages/skit/src/author/history.ts", names: ["AuthorHistory"] }],
    description:
      "SQLite stores tree entries, revision metadata and parent links. File contents are stored by hash.",
    sources: [
      selected("author/history-tables", "createAuthorMetadataTables"),
      core("artifact/file-bytes"),
      selected("history/history", "Tree", "Author", "Revision"),
      core("artifact/tree-entry"),
    ],
  },
  {
    id: "author-sync",
    name: "Author sync checkpoints",
    scope: "Device",
    format: "SQLite",
    paths: ["<home>/library.sqlite"],
    owner: "AuthorHistory",
    owners: [{ file: "packages/skit/src/author/history.ts", names: ["AuthorHistory"] }],
    description:
      "Per-workspace and Registry locator sync checkpoints, removal inventories and acknowledged backup revisions. SyncState defines the durable sync lifecycle.",
    sources: [
      selected("author/state-tables", "createAuthorStateTables"),
      core("sync/sync"),
      selected("author/inventory", "AuthorRemovalState"),
    ],
  },
  {
    id: "credentials",
    name: "Registry accounts and credentials",
    scope: "Device",
    format: "JSON and OS credential store",
    paths: ["<home>/auth.json", "macOS Keychain / Linux Secret Service"],
    owner: "RegistryAccounts / authentication",
    owners: [{ file: "packages/cli/src/registry/accounts.ts", names: ["RegistryAccounts"] }],
    description:
      "Registry accounts and credential references. Tokens use the OS store when available, with auth.json as the file fallback. Only source definitions appear here.",
    sources: [
      "packages/cli/src/registry/accounts.ts",
      "packages/cli/src/registry/credential-store.ts",
    ],
  },
  {
    id: "locks",
    name: "Home and workspace locks",
    scope: "Device",
    format: "SQLite lock files",
    paths: ["<home>/lock.sqlite", "<workspace>/.skit/lock.sqlite"],
    owner: "HomeLock / AuthorWorkspace",
    owners: [
      { file: "packages/skit/src/platform/home-lock.ts", names: ["withLock"] },
      { file: "packages/skit/src/author/workspace.ts", names: ["AuthorWorkspace"] },
    ],
    description:
      "SQLite exclusive transactions provide cross-process locks. These files contain no application records and are never unlinked.",
    sources: [core("platform/file-lock")],
  },
  {
    id: "workspace-identity",
    name: "Author Workspace identity",
    scope: "Workspace",
    format: "JSON",
    paths: ["<workspace>/.skit/workspace.json"],
    owner: "AuthorWorkspace",
    owners: [{ file: "packages/skit/src/author/workspace.ts", names: ["AuthorWorkspace"] }],
    description:
      "Stable device-local workspace identity. The older registration field is accepted when reading and is no longer written.",
    sources: [
      selected("author/workspace-metadata", "WorkspaceDocument"),
      selected("author/workspace-contracts", "WorkspaceId"),
    ],
  },
  {
    id: "workspace-connection",
    name: "Author connection checkpoint",
    scope: "Workspace",
    format: "JSON",
    paths: ["<workspace>/.skit/connection.json"],
    owner: "AuthorWorkspace",
    owners: [{ file: "packages/skit/src/author/workspace.ts", names: ["AuthorWorkspace"] }],
    description:
      "Durable Connecting checkpoint for creating a Registry SKIT. The remote receipt is written separately when connection succeeds.",
    sources: [selected("author/workspace-contracts", "Connecting")],
  },
  {
    id: "author-remote",
    name: "Author Registry destination",
    scope: "Workspace",
    format: "JSON",
    paths: ["<workspace>/skit.remote.json"],
    owner: "AuthorWorkspace",
    owners: [{ file: "packages/skit/src/author/workspace.ts", names: ["AuthorWorkspace"] }],
    description:
      "The workspace's normalized Registry destination, separate from its portable Descriptor and device-local identity.",
    sources: [core("author/remote")],
  },
  {
    id: "descriptor",
    name: "Collection Descriptor",
    scope: "Workspace",
    format: "JSON",
    paths: ["<collection>/skit.json"],
    owner: "Artifact / authoring",
    owners: [
      { file: "packages/skit/src/author/workspace.ts", names: ["AuthorWorkspace"] },
      { file: "packages/skit/src/artifact/skit.ts", names: ["readSkitDescriptor"] },
    ],
    description:
      "Portable collection declaration, contained skills, creator attribution and identity claims.",
    sources: [core("artifact/schemas")],
  },
  {
    id: "skill-files",
    name: "Skill files and invocation metadata",
    scope: "Workspace",
    format: "Markdown, YAML and related files",
    paths: ["<skill>/SKILL.md", "<skill>/agents/openai.yaml", "<skill>/**"],
    owner: "Artifact / Installed Skills / Harness invocation adapters",
    owners: [
      { file: "packages/skit/src/author/workspace.ts", names: ["AuthorWorkspace"] },
      {
        file: "packages/skit/src/installed-skills/files.ts",
        names: ["stageInstalledSkill", "commitInstalledSkill"],
      },
      {
        file: "packages/skit/src/harnesses/invocation-metadata.ts",
        names: ["invocationMetadataAdapters"],
      },
    ],
    description:
      "Authored and installed skill content. SKILL.md carries frontmatter and instructions; Codex invocation policy lives in agents/openai.yaml. Native metadata adapters define how SKIT writes each Harness's policy fields.",
    sources: [
      core("harnesses/invocation-metadata"),
      core("artifact/invocation-policy"),
      core("artifact/tree-entry"),
    ],
  },
  {
    id: "exports",
    name: "Exported archives and snapshots",
    scope: "Workspace",
    format: "Archive files",
    paths: ["<chosen-output-path>"],
    owner: "Artifact archive / Library snapshots",
    owners: [
      { file: "packages/skit/src/artifact/archive.ts", names: ["createSkitArchive"] },
      { file: "packages/skit/src/library/snapshot-archive.ts", names: ["writeVerifiedSnapshot"] },
    ],
    description:
      "Explicitly exported collection archives and portable Library snapshots. Snapshot archives include a manifest and the Collection Version content needed to restore it.",
    sources: [core("artifact/archive"), core("library/snapshot-archive")],
  },
  {
    id: "workspace-control",
    name: "Workspace control and staging files",
    scope: "Workspace",
    format: "Text and temporary file trees",
    paths: ["<workspace>/.skit/.gitignore", "<workspace>/.skit/stage-*"],
    owner: "AuthorWorkspace",
    owners: [{ file: "packages/skit/src/author/workspace.ts", names: ["AuthorWorkspace"] }],
    description:
      "The ignore file excludes private workspace control files from Git. Staging directories hold in-progress filesystem writes and may remain after interruption; these are working files rather than another document format.",
    sources: [core("author/workspace"), core("author/write-tree")],
  },
  {
    id: "repository-config",
    name: "Repository discovery configuration",
    scope: "Workspace",
    format: "JSON",
    paths: ["<repository>/skit.config.json"],
    owner: "Setup",
    owners: [
      { file: "packages/skit/src/library/setup/config.ts", names: ["readRepositoryConfig"] },
    ],
    description: "Repository-relative collection directories and discovery exclusions.",
    sources: [
      selected(
        "library/setup/config",
        "RepositoryRelativeGlob",
        "RepositoryRelativeDirectory",
        "RepositoryConfigDocument",
      ),
    ],
  },
  {
    id: "ownership",
    name: "Installed Skill ownership marker",
    scope: "Workspace",
    format: "JSON",
    paths: ["<installed-skill>/.skit-ownership.json"],
    owner: "Installed Skills",
    owners: [
      {
        file: "packages/skit/src/installed-skills/files.ts",
        names: ["stageInstalledSkill", "commitInstalledSkill"],
      },
    ],
    description:
      "Device-local evidence that SKIT installed and may change this folder. Includes compatibility readers for earlier markers.",
    sources: [
      core("installed-skills/ownership-marker"),
      core("installed-skills/ownership-marker-compat"),
    ],
  },
  {
    id: "recovery",
    name: "Removed folders and recovery receipts",
    scope: "Device",
    format: "JSON and file trees",
    paths: [
      "<home>/removed/<operation>/<batch>/receipt.json",
      "<home>/removed/<operation>/<batch>/<index>-<name>",
    ],
    owner: "Library recovery / setup",
    owners: [
      {
        file: "packages/skit/src/library/internal/recovery/moves.ts",
        names: ["prepareRecoveryMoves", "restoreRecorded"],
      },
      { file: "packages/skit/src/library/internal/setup/moves.ts", names: ["moveAside"] },
    ],
    description:
      "Moved folders and inverse evidence used for recovery and setup undo. Recovery also reads older operation-level receipts and earlier receipt versions.",
    sources: [
      core("library/internal/recovery/moves"),
      selected("library/internal/setup/moves", "ReceiptEntry", "Receipt"),
    ],
  },
  {
    id: "installed-backups",
    name: "Installed Skill backups",
    scope: "Workspace",
    format: "File trees",
    paths: ["<skills-directory-or-parent>/.skit-backups/"],
    owner: "Installed Skills",
    owners: [
      {
        file: "packages/skit/src/installed-skills/backups.ts",
        names: ["backUpInstalledSkill", "keepInstalledSkillBackup"],
      },
    ],
    description:
      "Copies moved aside during replacement or uninstall, with pending state until the Library save completes. Backups stay on the same filesystem as the skills directory.",
    sources: [core("installed-skills/backups")],
  },
  {
    id: "authored-inputs",
    name: "Authored collection inputs",
    scope: "Device",
    format: "JSON",
    paths: ["<prepared-collection>/skit.author-inputs.json"],
    owner: "Library content",
    owners: [
      {
        file: "packages/skit/src/library/internal/content/authored-inputs.ts",
        names: ["AuthoredInputs", "readAuthoredInputs"],
      },
    ],
    description:
      "Descriptor and selected declarations with revision or imported Collection Version provenance, used to reconstruct authored content.",
    sources: [
      selected("library/internal/content/authored-inputs", "AuthoredSelection", "AuthoredInputs"),
    ],
  },
  {
    id: "library-manifest",
    name: "Stored Library Manifest",
    scope: "Registry",
    format: "JSON",
    paths: ["Registry Library snapshots"],
    owner: "Library sync / Registry Library",
    owners: [
      {
        file: "packages/skit/src/library/store/stored-manifest.ts",
        names: ["StoredLibraryManifest"],
      },
      { file: "packages/skit-server-effect/src/library/service.ts", names: ["ServerLibrary"] },
    ],
    description:
      "Portable Library state saved in Registry snapshots. The storage decoder accepts historical manifests and upgrades to the current contract; device installation state stays local.",
    sources: [core("library/library-contracts"), core("library/store/stored-manifest")],
  },
  {
    id: "registry-objects",
    name: "Registry object storage",
    scope: "Registry",
    format: "R2 objects",
    paths: ["Registry R2 bucket"],
    owner: "Registry SKITs / Library",
    owners: [
      { file: "packages/skit-server-effect/src/skits/service.ts", names: ["Skits"] },
      { file: "packages/skit-server-effect/src/library/service.ts", names: ["ServerLibrary"] },
    ],
    description:
      "Content-addressed author blobs, release archives and Library snapshot objects. The sources below define keys, serialization and reads/writes.",
    sources: [
      "packages/skit-server-effect/src/skits/internal/release-archive.ts",
      "packages/skit-server-effect/src/library/internal/snapshots.ts",
      { file: "packages/skit-server-effect/src/skits/service.ts", names: ["blobKey"] },
    ],
  },
];

/** Includes shared Registry database owners as well as the format-specific owners. */
export const storeOwnerFiles = [
  ...new Set([
    ...stores.flatMap((store) => store.owners.map((owner) => owner.file)),
    "packages/skit-server-effect/src/identity/service.ts",
    "packages/skit-server-effect/src/teams/service.ts",
    "packages/skit-server-effect/src/feedback/service.ts",
  ]),
];

/** Exact source and line numbers, with missing named definitions treated as a build error. */
async function definitions(root: string, source: Source): Promise<PersistedStore["definitions"]> {
  const file = typeof source === "string" ? source : source.file;
  const text = await readFile(join(root, file), "utf8");
  if (typeof source === "string")
    return [{ file, line: 1, name: file.split("/").at(-1)!, source: text }];
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return source.names.map((name) => {
    let found: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      if (
        (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
        node.name?.getText(parsed) === name
      )
        found = node;
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    if (!found) throw new Error(`Persisted data definition missing: ${file}#${name}`);
    return {
      file,
      name,
      line: parsed.getLineAndCharacterOfPosition(found.getStart()).line + 1,
      source: found.getText(parsed),
    };
  });
}

export async function persistedStores(
  root: string,
  program?: ts.Program,
): Promise<readonly PersistedStore[]> {
  program ??= await atlasProgram(root);
  const errors = inspectErrors(program, root, storeOwnerFiles);
  const resolveOwners = (sources: Store["owners"]) =>
    sources.flatMap((source) => ownerSymbols(program!, root, source, errors));
  const result = await Promise.all(
    stores.map(async ({ sources, owners, ...store }) => ({
      owners: resolveOwners(owners),
      ...store,
      definitions: (await Promise.all(sources.map((source) => definitions(root, source)))).flat(),
    })),
  );
  const directory = "packages/skit-server-effect/migrations";
  const migrations = (await readdir(join(root, directory)))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  result.push({
    id: "registry-database",
    name: "Registry database",
    scope: "Registry",
    format: "D1 / SQLite",
    paths: ["Registry D1 database"],
    owner: "Registry",
    owners: resolveOwners([
      { file: "packages/skit-server-effect/src/skits/service.ts", names: ["Skits"] },
      { file: "packages/skit-server-effect/src/library/service.ts", names: ["ServerLibrary"] },
      { file: "packages/skit-server-effect/src/identity/service.ts", names: ["Identity"] },
      { file: "packages/skit-server-effect/src/teams/service.ts", names: ["Teams"] },
      { file: "packages/skit-server-effect/src/feedback/service.ts", names: ["Feedback"] },
    ]),
    description:
      "Ordered SQL migration history for accounts, access grants, author revisions, releases, Library snapshots, device authorization and feedback. Read in order: later migrations alter or replace earlier tables; an earlier CREATE TABLE alone is not the current schema.",
    definitions: (
      await Promise.all(migrations.map((file) => definitions(root, `${directory}/${file}`)))
    ).flat(),
  });
  return result;
}

/** Resolve curated ownership claims against code; missing symbols fail the build. */
function ownerSymbols(
  program: ts.Program,
  root: string,
  source: { readonly file: string; readonly names: readonly string[] },
  errors: readonly ErrorDefinition[],
): PersistedStore["owners"] {
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(join(root, source.file));
  const module = file && checker.getSymbolAtLocation(file);
  if (!file || !module) throw new Error(`Store owner module missing: ${source.file}`);
  const exports = checker.getExportsOfModule(module);
  return source.names.map((name) => {
    let symbol = exports.find((symbol) => symbol.name === name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const node = symbol?.valueDeclaration;
    if (!node) throw new Error(`Store owner symbol missing: ${source.file}#${name}`);
    const keys = new Set(
      errors
        .filter((error) => error.services.includes(`${name} (${source.file})`))
        .map((error) => `${error.file}/${error.name}`),
    );
    const collect = (type: ts.Type) => {
      if (type.isUnion()) return type.types.forEach(collect);
      for (const declaration of type.symbol?.declarations ?? []) {
        const error = errors.find(
          (error) =>
            join(root, error.file) === declaration.getSourceFile().fileName &&
            error.name === type.symbol?.name,
        );
        if (error) keys.add(`${error.file}/${error.name}`);
      }
    };
    for (const signature of checker.getTypeAtLocation(node).getCallSignatures()) {
      const returned = checker.getReturnTypeOfSignature(signature);
      if (returned.symbol?.name === "Effect") {
        const failure = checker.getTypeArguments(returned as ts.TypeReference)[1];
        if (failure) collect(failure);
      }
    }
    return {
      name,
      file: source.file,
      line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      source: node.getText(),
      errors: [...keys].sort(),
    };
  });
}
