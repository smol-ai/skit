import { Data } from "effect";
import {
  makeCollectionId,
  makeOperationId,
  makeProjectionId,
  makeRetainedCopyId,
  makeSkillId,
  makeSkillVersionId,
} from "@smolai/skit-core";
import type { AnyOutputContract, ContractDataOf } from "../commands/output-contracts.js";
import { outputContracts } from "../commands/output-contracts.js";
import type { CommandFailure, CommandResult } from "../commands/types.js";
import { result } from "../handlers/contracts.js";

export type OutputStory = Data.TaggedEnum<{
  Result: { readonly name: string; readonly group: string; readonly result: CommandResult };
  Failure: { readonly name: string; readonly group: string; readonly failure: CommandFailure };
}>;

export const OutputStory = Data.taggedEnum<OutputStory>();

function resultStory<C extends AnyOutputContract>(
  group: string,
  name: string,
  contract: C,
  data: ContractDataOf<NoInfer<C>>,
): OutputStory {
  return OutputStory.Result({ group, name, result: result("storybook", contract, data) });
}

const failureStory = (name: string, failure: CommandFailure): OutputStory =>
  OutputStory.Failure({ group: "failure", name, failure });

const digest = `sha256:${"0".repeat(64)}`;
const skillRef = "skill-version-story";
const collectionId = makeCollectionId();
const versionId = makeRetainedCopyId();
const otherVersionId = makeRetainedCopyId();
const skillVersionId = makeSkillVersionId();
const skillId = makeSkillId();
const retainedTreeId = makeRetainedCopyId();
const projectionId = makeProjectionId();
const binding = {
  harness: "codex" as const,
  scope: { kind: "global" as const },
  skills: [skillId],
};
const emptyAudit = {
  ruleset: { id: "skit/skill-static-audit" as const, version: "1" },
  declaredCapabilities: [],
  inferredCapabilities: [],
  undeclaredCapabilities: [],
  triggerBreadth: "explicit_only" as const,
  authorityEffect: "none" as const,
  confirmationEffect: "none" as const,
  riskFlags: [],
  truncatedEvidence: { critical: 0, nonCriticalCapabilities: [] },
  findings: [],
};
const emptyAssessment = {
  context: "project" as const,
  outcome: "allow" as const,
  reasons: [],
  findingDecisions: [],
};

export const outputStories: ReadonlyArray<OutputStory> = [
  resultStory("version", "current", outputContracts.version, { version: "0.1.0" }),
  resultStory("library-history", "change", outputContracts.libraryHistory, {
    events: [
      {
        schemaVersion: 1,
        eventId: makeOperationId(),
        occurredAt: "2026-09-17T00:00:00.000Z",
        type: "binding.enabled",
        workflow: "enable",
        changes: [{ entity: "binding", id: `${collectionId}:codex:global`, action: "enabled" }],
      },
    ],
  }),
  resultStory("author-init", "empty", outputContracts.init, {
    path: "/work/review-tools",
    library_registration: "registered",
  }),
  resultStory("author-init", "discovered-skills", outputContracts.init, {
    path: "/work/review-tools",
    library_registration: "registered",
    discovered: {
      skills: 2,
      skillEntries: [
        { name: "review", path: "skills/review" },
        { name: "triage", path: "skills/triage" },
      ],
      readme: true,
      git: true,
      skillsLock: { present: false, entries: 0 },
    },
  }),
  resultStory("validate", "valid", outputContracts.validate, {
    valid: true,
    status: "valid",
    identity: { slug: "review-tools", release: "1.2.0", releaseContentHash: digest, skills: [] },
    diagnostics: [],
    audits: {},
    assessments: {},
  }),
  resultStory("validate", "warning", outputContracts.validate, {
    valid: true,
    status: "valid-with-warnings",
    identity: { slug: "review-tools", release: "1.2.0", releaseContentHash: digest, skills: [] },
    diagnostics: [
      {
        code: "UNDOCUMENTED_CAPABILITY",
        severity: "warning",
        message: "Network use is not documented",
        path: "skills/review/SKILL.md",
      },
    ],
    audits: {},
    assessments: {},
  }),
  resultStory("author-invocation", "changed", outputContracts.authorInvocation, {
    path: "/work/review-tools",
    dryRun: false,
    generated: [
      { skill: "review", harness: "codex", path: "AGENTS.md", policy: "explicit", changed: true },
    ],
  }),
  resultStory("author-list", "empty", outputContracts.authorList, {
    registry: "https://registry.example",
    skits: [],
  }),
  resultStory("author-list", "populated", outputContracts.authorList, {
    registry: "https://registry.example",
    skits: [
      {
        identity: "https://registry.example/smol-ai/review-tools",
        visibility: "public",
        draft_revision_id: "draft-7",
        most_recent_release_version: "1.2.0",
      },
      {
        identity: "https://registry.example/smol-ai/triage-tools",
        visibility: "private",
        draft_revision_id: "draft-3",
        most_recent_release_version: null,
      },
    ],
  }),
  resultStory("author-delete", "deleted", outputContracts.authorDelete, {
    status: "deleted",
    skit_id: "smol-ai/review-tools",
    changed: true,
    draft_revisions: 2,
    releases: 1,
    release_versions: ["1.2.0"],
    archive_cleanup: "complete",
  }),
  resultStory("add", "retained", outputContracts.add, {
    collection_id: collectionId,
    skill_ids: [skillId],
    retained_version_id: versionId,
    snapshot_digest: digest,
    skills: [{ name: "review", verbatim_path: "." }],
  }),
  resultStory("add", "preview", outputContracts.addPreview, {
    kind: "plain",
    skills: [{ name: "review", verbatim_path: "." }],
  }),
  resultStory("pull", "current", outputContracts.pull, []),
  resultStory("list", "empty", outputContracts.list, { subjects: [], bindings: [] }),
  resultStory("list", "populated", outputContracts.list, {
    subjects: [
      {
        subject_id: collectionId,
        subject_kind: "collection",
        label: "story/review",
        skills: [
          {
            name: "review",
            skill_id: skillId,
            selected_skill_version_id: skillVersionId,
            versions: [{ skill_version_id: skillVersionId, artifact_digest: digest }],
          },
        ],
      },
    ],
    bindings: [{ harness: "codex", skills: [skillId] }],
  }),
  resultStory("security-review", "clean", outputContracts.securityReview, {
    skillRef,
    artifactContentDigest: digest,
    audit: emptyAudit,
    assessment: emptyAssessment,
    acceptances: [],
  }),
  resultStory("security-accept", "clean", outputContracts.securityAccept, {
    skillRef,
    artifactContentDigest: digest,
    audit: emptyAudit,
    assessment: emptyAssessment,
    acceptances: [],
  }),
  resultStory("setup", "plan", outputContracts.setup, {
    machineConfig: {
      path: "/home/story/.skit/machine.json",
      repositoryRoots: ["/work"],
      repositoryDecisions: [],
      persisted: false,
    },
    probes: [
      { harness: "claude-code", status: "installed", command: "claude" },
      { harness: "codex", status: "missing", command: "codex" },
      { harness: "opencode", status: "missing", command: "opencode" },
      { harness: "devin", status: "missing", command: "devin" },
    ],
    scan: { complete: true, directoriesExamined: 42, repositorySearchDepth: 1 },
    repositories: [{ path: "/work/review-tools", skills: ["review"], status: "undecided" }],
    repositoryConfigs: [],
    authoredCollections: [],
    projections: [],
    onboarding: {
      planId: `sha256:${"0".repeat(64)}`,
      candidates: [
        {
          name: "review",
          paths: ["/home/story/.claude/skills/review"],
          owner: { kind: "unknown" },
          action: "manage-locally",
          sourceSelection: "automatic",
          sourcePath: "/home/story/.claude/skills/review",
        },
      ],
    },
    locks: [],
    instances: [
      {
        name: "review",
        path: "/home/story/.claude/skills/review",
        aliases: ["/home/story/.claude/skills/review"],
        scope: "global",
        harnesses: ["claude-code"],
        owner: { kind: "unknown" },
        contentIdentity: { status: "none", libraryMatches: [] },
        git: { status: "outside-git" },
        locks: [],
      },
    ],
    brokenLinks: [],
    suppressed: [],
  }),
  resultStory("repository", "policy", outputContracts.repositoryPolicy, {
    action: "list",
    path: "",
    repositories: [
      { path: "/work/review-tools", status: "watched" },
      { path: "/work/scratch", status: "ignored" },
    ],
  }),
  resultStory("inventory", "empty", outputContracts.inventory, {
    schemaVersion: 5,
    skills: [],
    projections: [],
    unmanaged: [],
    machine: {
      repositoryRoots: ["/home/story/dev"],
      repositoryDecisions: [],
      scan: { complete: true, directoriesExamined: 1, repositorySearchDepth: 1 },
      instances: [],
      brokenLinks: [],
      suppressed: [],
    },
  }),
  resultStory("doctor", "healthy", outputContracts.doctor, { ok: true, issues: [] }),
  resultStory("doctor", "projection-conflict", outputContracts.doctor, {
    ok: false,
    issues: [
      {
        code: "PROJECTION_CONFLICT",
        skillId,
        path: "/home/story/.codex/skills/review",
        harness: "codex",
      },
    ],
  }),
  resultStory("auth-status", "signed-out", outputContracts.authStatus, {
    credentials: [],
  }),
  resultStory("auth-status", "signed-in", outputContracts.authStatus, {
    credentials: [
      {
        origin: "https://registry.example",
        aliases: ["public"],
        tokenPrefix: "sk_live_…",
        scopes: ["publish", "draft:write"],
        expiresAt: "2027-01-01T00:00:00Z",
        expiry: "known",
        expired: false,
        isDefault: true,
        source: "stored",
      },
    ],
  }),
  resultStory("registry-list", "empty", outputContracts.registryList, { registries: [] }),
  resultStory("registry-list", "configured", outputContracts.registryList, {
    registries: [
      { name: "public", origin: "https://registry.example", isDefault: true },
      { name: "team", origin: "https://skills.example", isDefault: false },
    ],
  }),
  resultStory("check", "current", outputContracts.check, [
    {
      subject_id: collectionId,
      subject_kind: "collection",
      label: "review-tools",
      retained_copies: [{ retained_copy_id: retainedTreeId, digest, retained_bytes_current: true }],
      unresolved_skill_selections: 0,
      source_status: "unverified",
      acquisition_provenance: true,
    },
  ]),
  resultStory("update", "available", outputContracts.updatePlan, [
    {
      subject_id: collectionId,
      subject_kind: "collection",
      current_snapshot_digest: digest,
      available_snapshot_digest: `sha256:${"1".repeat(64)}`,
      changed: true,
    },
  ]),
  resultStory("update", "applied", outputContracts.update, [
    {
      subject_id: collectionId,
      subject_kind: "collection",
      previous_retained_copy_id: versionId,
      selected_retained_copy_id: otherVersionId,
      snapshot_digest: `sha256:${"1".repeat(64)}`,
      changed: true,
      projected: 1,
      deferred: 0,
    },
  ]),
  resultStory("update-projection", "preview", outputContracts.projectionRetentionPlan, {
    revision: "library-revision-story",
    skill_id: skillId,
    skill_name: "review",
    previous_skill_version_id: skillVersionId,
    selected_projection_id: projectionId,
    observed_digest: digest,
    snapshot_digest: digest,
    retained_path: `/home/story/.skit/originals/${digest}`,
    retention_required: true,
    projections: [
      {
        projection_id: projectionId,
        harness: "codex",
        path: "/home/story/.codex/skills/review",
        observed_digest: digest,
        agreement: "selected",
      },
    ],
  }),
  resultStory("update-projection", "retained", outputContracts.projectionRetention, {
    skill_id: skillId,
    skill_name: "review",
    previous_skill_version_id: skillVersionId,
    retained_skill_version_id: makeSkillVersionId(),
    retained_copy_id: retainedTreeId,
    snapshot_digest: digest,
    retained: true,
    projections: [
      {
        projection_id: projectionId,
        harness: "codex",
        path: "/home/story/.codex/skills/review",
        status: "projected",
      },
    ],
  }),
  resultStory("pin", "preview", outputContracts.pinPlan, {
    subject_id: collectionId,
    skills: [
      {
        skill_id: skillId,
        skill: "review",
        current_version_id: skillVersionId,
        selected_version_id: skillVersionId,
      },
    ],
    retained: true,
    changed: true,
    bindings: 1,
  }),
  resultStory("pin", "applied", outputContracts.pin, {
    subject_id: collectionId,
    skills: [
      {
        skill_id: skillId,
        skill: "review",
        current_version_id: skillVersionId,
        selected_version_id: skillVersionId,
      },
    ],
    retained: true,
    changed: true,
    bindings: 1,
    projected: 1,
    deferred: 0,
  }),
  resultStory("remove", "preview", outputContracts.removePlan, {
    subject_id: collectionId,
    subject_kind: "collection",
    versions: 1,
    skills: 1,
    global_bindings: 1,
    repository_bindings: 0,
    owned_projections: 1,
  }),
  resultStory("remove", "applied", outputContracts.remove, {
    subject_id: collectionId,
    subject_kind: "collection",
    versions: 1,
    skills: 1,
    global_bindings: 1,
    repository_bindings: 0,
    owned_projections: 1,
    retired: 1,
  }),
  resultStory("enable", "preview", outputContracts.enablePlan, {
    subject_id: collectionId,
    skills: ["review"],
    harnesses: ["codex"],
    scope: { kind: "global" },
    enabled: true,
    changed: true,
    bindings: [binding],
  }),
  resultStory("enable", "applied", outputContracts.enable, {
    subject_id: collectionId,
    skills: ["review"],
    harnesses: ["codex"],
    scope: { kind: "global" },
    enabled: true,
    changed: true,
    bindings: [binding],
    projections: [{ harness: "codex", status: "projected" }],
  }),
  resultStory("disable", "preview", outputContracts.disablePlan, {
    subject_id: collectionId,
    skills: ["review"],
    harnesses: ["codex"],
    scope: { kind: "global" },
    enabled: false,
    changed: true,
    bindings: [],
  }),
  resultStory("disable", "applied", outputContracts.disable, {
    subject_id: collectionId,
    skills: ["review"],
    harnesses: ["codex"],
    scope: { kind: "global" },
    enabled: false,
    changed: true,
    bindings: [],
    projections: [{ harness: "codex", status: "projected" }],
  }),
  resultStory("publish", "release", outputContracts.publish, {
    release: {
      release_id: "release-1",
      version: "1.2.0",
      revision_id: "draft-7",
      archive_digest: digest,
      download_path: "/api/skits/smol-ai/review-tools/releases/1.2.0",
    },
  }),
  resultStory("sync", "first-sync-ready", outputContracts.sync, {
    status: "first_sync_ready",
    changed: true,
    identity: {
      authority: "registry.example",
      namespace: "smol-ai",
      skit: "review-tools",
      ref: "registry.example/smol-ai/review-tools",
    },
    visibility: "private",
    file_count: 3,
    effects: ["create_skit", "create_draft", "record_remote_home"],
  }),
  resultStory("sync", "conflicted", outputContracts.sync, {
    status: "conflicted",
    changed: false,
    conflicts: [{ path: "SKIT.md", kind: "both_modified" }],
  }),
  resultStory("library-sync", "merged", outputContracts.librarySync, {
    status: "merged",
    changed: true,
    revision_id: "revision-story",
    snapshots: 1,
    projected: 1,
    deferred: 0,
  }),
  resultStory("server-bootstrap", "complete", outputContracts.serverBootstrap, {
    origin: "https://registry.example",
    status: "complete",
  }),
  resultStory("server-bootstrap", "already-complete", outputContracts.serverBootstrap, {
    origin: "https://registry.example",
    status: "already_complete",
  }),
  resultStory("auth-login", "authenticated", outputContracts.authLogin, {
    origin: "https://registry.example",
    tokenPrefix: "sk_live_…",
    scopes: ["publish", "draft:write"],
    expiresAt: "2027-01-01T00:00:00Z",
  }),
  resultStory("auth-logout", "revoked", outputContracts.authLogout, {
    origin: "https://registry.example",
    revoked: true,
  }),
  resultStory("registry", "added", outputContracts.registryRemote, {
    action: "added",
    name: "team",
    origin: "https://registry.example",
    isDefault: false,
  }),
  resultStory("harness-probe", "mixed", outputContracts.experimentalHarnessProbe, {
    probes: [
      {
        harnessId: "codex",
        status: "installed",
        command: "codex",
        executablePath: "/usr/local/bin/codex",
        resolvedPath: "/opt/codex/bin/codex",
        version: "1.0.0",
        versionOutput: "codex 1.0.0",
        error: null,
      },
    ],
  }),
  resultStory("audit", "empty-v1alpha1", outputContracts.experimentalAudit, {
    generatedAt: "2026-01-01T00:00:00Z",
    home: "/home/story",
    cwd: "/work/review-tools",
    coverage: { supported: [], deferred: [] },
    observations: [],
    findings: [],
    probes: [],
    summary: { capabilities: 0, findings: 0 },
  }),
  resultStory("audit", "findings-v1alpha1", outputContracts.experimentalAudit, {
    generatedAt: "2026-01-01T00:00:00Z",
    home: "/home/story",
    cwd: "/work/review-tools",
    coverage: { supported: [], deferred: [] },
    observations: [
      {
        kind: "mcp-server",
        name: "github",
        harnesses: ["codex"],
        scope: "user",
        path: "/home/story/.codex/config.toml",
        mcp: { transport: "http", url: "https://mcp.example", args: [] },
        provenance: { confidence: "exact", source: "codex", evidence: "config" },
      },
    ],
    findings: [
      {
        severity: "warning",
        code: "remote-mcp-server",
        subject: "github",
        problem: "Remote MCP server can receive repository context",
        locations: ["/home/story/.codex/config.toml"],
        details: { transport: "http" },
      },
    ],
    probes: [{ harness: "codex", status: "ok", observed: { mcpServers: 1 } }],
    summary: { capabilities: 1, findings: 1 },
  }),
  resultStory("audit", "empty-v1alpha3", outputContracts.experimentalAuditV1Alpha3, {
    schemaVersion: "v1alpha3",
    generatedAt: "2026-01-01T00:00:00Z",
    roots: { home: "/home/story", cwd: "/work/review-tools" },
    harnesses: [],
    skills: [],
    plugins: [],
    mcpServers: [],
    rules: [],
    marketplaces: [],
    findings: [],
    probes: [],
    coverage: { deferredHarnessIds: [] },
    summary: {
      harnesses: 0,
      skills: 0,
      plugins: 0,
      mcpServers: 0,
      rules: 0,
      marketplaces: 0,
      findings: 0,
    },
  }),
  resultStory("audit", "findings-v1alpha3", outputContracts.experimentalAuditV1Alpha3, {
    schemaVersion: "v1alpha3",
    generatedAt: "2026-01-01T00:00:00Z",
    roots: { home: "/home/story", cwd: "/work/review-tools" },
    harnesses: [
      {
        id: "codex",
        detected: true,
        profileId: "codex",
        profileVersion: "1",
        frontmatterContracts: [],
        skillMetadataContracts: [],
        documentation: [],
        entryIds: ["mcp:github"],
      },
    ],
    skills: [],
    plugins: [],
    mcpServers: [
      {
        id: "mcp:github",
        name: "github",
        harnessIds: ["codex"],
        scope: "user",
        location: "/home/story/.codex/config.toml",
        provenance: { confidence: "exact", source: "codex", evidence: "config" },
        enabled: true,
        active: true,
        transport: "http",
        args: [],
        url: "https://mcp.example",
      },
    ],
    rules: [],
    marketplaces: [],
    findings: [
      {
        id: "finding:remote-mcp",
        severity: "warning",
        code: "remote-mcp-server",
        entryIds: ["mcp:github"],
        unresolvedSubject: null,
        problem: "Remote MCP server can receive repository context",
        locations: ["/home/story/.codex/config.toml"],
        details: { transport: "http" },
      },
    ],
    probes: [{ harnessId: "codex", status: "ok", observed: { mcpServers: 1 } }],
    coverage: { deferredHarnessIds: [] },
    summary: {
      harnesses: 1,
      skills: 0,
      plugins: 0,
      mcpServers: 1,
      rules: 0,
      marketplaces: 0,
      findings: 1,
    },
  }),
  failureStory("not-found", {
    code: "NOT_FOUND",
    exitCode: 11,
    message: "The requested Library Entry does not exist",
    remediation: "Run `skit list` and choose an existing Collection Reference.",
  }),
  failureStory("projection-conflict", {
    code: "CONFLICT",
    exitCode: 12,
    message: "The Projection Target contains content SKIT does not own",
    remediation: "Run `skit doctor` and reconcile the conflicting Projection.",
  }),
];

export const outputStoryKey = (story: OutputStory): string => `${story.group}/${story.name}`;
