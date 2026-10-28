import { emptyUsageStory, usageStory } from "./usage-stories.js";
import { estimateCodexListing } from "@smolai/skit-core";
import { Data } from "effect";
import {
  makeCollectionId,
  makeOperationId,
  makeInstalledSkillId,
  makeCollectionVersionId,
  makeSkillId,
  makeSkillVersionId,
} from "@smolai/skit-core";
import type { CommandFailure, CommandResult } from "../commands/types.js";
import { result } from "../handlers/contracts.js";
import { recoveryActions } from "../commands/recovery-contract.js";
import { setupUndoActions } from "../commands/setup-undo-contract.js";

export type OutputStory = Data.TaggedEnum<{
  Result: { readonly name: string; readonly group: string; readonly result: CommandResult };
  Failure: { readonly name: string; readonly group: string; readonly failure: CommandFailure };
}>;

export const OutputStory = Data.taggedEnum<OutputStory>();

const resultStory = (group: string, name: string, result: CommandResult): OutputStory =>
  OutputStory.Result({ group, name, result });

const failureStory = (name: string, failure: CommandFailure): OutputStory =>
  OutputStory.Failure({ group: "failure", name, failure });

const digest = `sha256:${"0".repeat(64)}`;
const collectionId = makeCollectionId();
const versionId = makeCollectionVersionId();
const otherVersionId = makeCollectionVersionId();
const skillVersionId = makeSkillVersionId();
const skillId = makeSkillId();
const collectionVersionId = makeCollectionVersionId();
const installedSkillId = makeInstalledSkillId();
const enabled = [{ skill: skillId }];
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

const doctorListingBudget = estimateCodexListing({
  cwd: "/home/story/project",
  model: "gpt-6.1-sol",
  contextWindow: 373000,
  skills: [
    {
      name: "review",
      path: "/home/story/.agents/skills/review/SKILL.md",
      scope: "user",
      description: "Review code changes and find regressions. ".repeat(20),
    },
  ],
});

export const outputStories: ReadonlyArray<OutputStory> = [
  resultStory("usage", "empty", result("usage", emptyUsageStory)),
  resultStory("usage", "observed", result("usage", usageStory)),
  resultStory(
    "version",
    "build-report",
    result("versionReport", {
      version: "0.2.0",
      build: { kind: "release", version: "0.2.0", commit: "0123456789abcdef" },
      update: {
        status: "current",
        channel: "latest",
        source: "https://registry.npmjs.org/-/package/@smolai/skit/dist-tags",
        available: "0.2.0",
      },
    }),
  ),
  resultStory("version", "current", result("version", { version: "0.1.0" })),
  resultStory(
    "library-history",
    "change",
    result("libraryHistory", {
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
  ),
  resultStory(
    "author-init",
    "empty",
    result("init", {
      path: "/work/review-tools",
      library_registration: "registered",
    }),
  ),
  resultStory(
    "author-init",
    "discovered-skills",
    result("init", {
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
  ),
  resultStory(
    "validate",
    "valid",
    result("validate", {
      valid: true,
      status: "valid",
      identity: { slug: "review-tools", release: "1.2.0", releaseContentHash: digest, skills: [] },
      diagnostics: [],
      audits: {},
      assessments: {},
    }),
  ),
  resultStory(
    "validate",
    "warning",
    result("validate", {
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
  ),
  resultStory(
    "author-invocation",
    "changed",
    result("authorInvocation", {
      path: "/work/review-tools",
      dryRun: false,
      generated: [
        { skill: "review", harness: "codex", path: "AGENTS.md", policy: "explicit", changed: true },
      ],
    }),
  ),
  resultStory(
    "author-list",
    "empty",
    result("authorList", {
      registry: "https://registry.example",
      skits: [],
    }),
  ),
  resultStory(
    "author-list",
    "populated",
    result("authorList", {
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
  ),
  resultStory(
    "author-delete",
    "deleted",
    result("authorDelete", {
      status: "deleted",
      skit_id: "smol-ai/review-tools",
      changed: true,
      draft_revisions: 2,
      releases: 1,
      release_versions: ["1.2.0"],
      archive_cleanup: "complete",
    }),
  ),
  ...(["added", "updated", "unchanged"] as const).map((action) =>
    resultStory(
      "add",
      action,
      result("add", {
        action,
        collection_id: collectionId,
        skill_ids: [skillId],
        collection_version_id: versionId,
        snapshot_digest: digest,
        skills: [{ name: "review", verbatim_path: "." }],
      }),
    ),
  ),
  resultStory(
    "add",
    "preview",
    result("addPreview", {
      kind: "plain",
      skills: [{ name: "review", verbatim_path: "." }],
    }),
  ),
  resultStory("list", "empty", result("list", { subjects: [], enabled: [], enabled_skills: [] })),
  resultStory(
    "list",
    "populated",
    result("list", {
      subjects: [
        {
          subject_id: collectionId,
          subject_kind: "collection",
          label: "story/review",
          skills: [
            {
              source: "https://skit.example.com/demo/tools",
              revision: "0.1.0",
              source_updated_at: "2026-09-20T00:00:00.000Z",
              imported_at: "2026-09-29T00:00:00.000Z",
              name: "review",
              skill_id: skillId,
              selected_skill_version_id: skillVersionId,
              versions: [{ skill_version_id: skillVersionId, artifact_digest: digest }],
            },
          ],
        },
      ],
      enabled: [{ collection: collectionId, label: "review-tools" }],
      enabled_skills: [skillId],
    }),
  ),
  resultStory(
    "security-review",
    "clean",
    result("securityReview", {
      skill_version_id: skillVersionId,
      artifactContentDigest: digest,
      audit: emptyAudit,
      assessment: emptyAssessment,
      acceptances: [],
    }),
  ),
  resultStory(
    "security-accept",
    "clean",
    result("securityAccept", {
      skill_version_id: skillVersionId,
      artifactContentDigest: digest,
      audit: emptyAudit,
      assessment: emptyAssessment,
      acceptances: [],
    }),
  ),
  resultStory(
    "setup",
    "plan",
    result("setup", {
      actions: [],
      choices: [],
      machineConfig: {
        path: "/home/story/.skit/machine.json",
        repositoryRoots: ["/work"],
        repositoryDecisions: [],
        persisted: false,
      },
      suggestedRepositoryRoots: [],
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
      installedSkills: [],
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
        recommended: {
          sources: [],
          copies: [{ name: "review", sourcePath: "/home/story/.claude/skills/review" }],
        },
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
  ),
  resultStory(
    "setup",
    "applied",
    result("setupApplied", {
      actions: [],
      planId: `sha256:${"0".repeat(64)}`,
      imported: [],
      added: [{ name: "review", sourcePath: "/home/story/.claude/skills/review" }],
      reconnected: [],
      installedSkills: [
        {
          name: "review",
          destination: "agents",
          path: "/home/story/.agents/skills/review",
          status: "installed",
        },
        {
          name: "review",
          destination: "claude",
          path: "/home/story/.claude/skills/review",
          status: "installed",
        },
      ],
      leftAlone: [
        {
          name: "commit",
          paths: ["/home/story/.agents/skills/commit", "/home/story/.claude/skills/commit"],
          reason: "divergent-copies",
        },
      ],
    }),
  ),
  resultStory(
    "setup",
    "review",
    result("setupReview", {
      planId: digest,
      reviewId: digest,
      hasChanges: true,
      canApply: true,
      summary: {
        sourceUpdateMayNeedReview: false,
        changes: [],
        versionChoices: [],
        savesMachineSettings: false,
        createsMachineIdentity: false,
        sources: [],
        enables: [{ name: "review", path: "/home/story/Work/skills/review" }],
        retains: [],
        preserves: [{ name: "review", path: "/home/story/.codex/skills/review", kind: "symlink" }],
        removals: [],
      },
      actions: [],
    }),
  ),
  resultStory(
    "setup",
    "comparison",
    result("setupComparison", {
      planId: digest,
      copies: [
        {
          name: "review",
          path: "/home/story/.claude/skills/review",
          observedHash: digest,
          markdown: "---\nname: review\ndescription: Review code\n---\nReview code.\n",
          truncated: false,
        },
      ],
      actions: [],
    }),
  ),
  resultStory(
    "setup",
    "failed",
    result("setupFailed", {
      code: "CONFLICT",
      message: "The machine changed after this setup plan was reviewed",
      remediation: "Run `skit setup --json` again to review the current machine.",
      actions: [],
    }),
  ),
  resultStory(
    "setup",
    "undo-preview",
    result("setupUndo", {
      operationId: "story-operation",
      planId: digest,
      status: "ready",
      phase: "preview",
      conflicts: [],
      files: [{ path: "/home/story/.codex/skills/review", kind: "restore" }],
      intentChanged: true,
      settingsChanged: false,
      sourceSelections: [],
      actions: setupUndoActions("/home/story/.skit", "story-operation", digest),
    }),
  ),
  resultStory(
    "recovery",
    "list",
    result("recoveryList", {
      operations: [
        {
          operationId: "story-operation",
          actions: recoveryActions("/home/story/.skit", "story-operation"),
        },
      ],
    }),
  ),
  resultStory(
    "recovery",
    "inspection",
    result("recovery", {
      operationId: "story-operation",
      directory: "/home/story/.skit/removed/story-operation",
      planId: digest,
      entries: [
        {
          name: "review",
          path: "/home/story/.codex/skills/review",
          recoveryPath: "/home/story/.skit/removed/story-operation/batch/review",
          type: "SymbolicLink",
          status: "saved",
          reason: "Saved by setup",
        },
      ],
      legacy: false,
      phase: "inspection",
      actions: recoveryActions("/home/story/.skit", "story-operation"),
    }),
  ),
  resultStory(
    "repository",
    "policy",
    result("repositoryPolicy", {
      action: "list",
      path: "",
      repositories: [
        { path: "/work/review-tools", status: "watched" },
        { path: "/work/scratch", status: "ignored" },
      ],
    }),
  ),
  resultStory(
    "inventory",
    "empty",
    result("inventory", {
      skills: [],
      installed_skills: [],
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
  ),
  resultStory(
    "inventory",
    "copy-dates",
    result("inventory", {
      skills: [],
      installed_skills: [],
      unmanaged: [],
      machine: {
        repositoryRoots: [],
        repositoryDecisions: [],
        scan: { complete: true, directoriesExamined: 2, repositorySearchDepth: 1 },
        instances: [
          {
            name: "review",
            path: "/home/story/.codex/skills/review",
            aliases: ["/home/story/.agents/skills/review"],
            scope: "global",
            harnesses: ["codex"],
            owner: { kind: "skills-sh", source: "example/skills" },
            contentIdentity: { status: "none", libraryMatches: [] },
            git: { status: "outside-git" },
            locks: [],
            skill_md_modified_at: "2026-05-01T12:00:00.000Z",
          },
          {
            name: "review",
            path: "/home/story/.claude/skills/review",
            aliases: [],
            scope: "global",
            harnesses: ["claude-code"],
            owner: { kind: "skills-sh", source: "example/skills" },
            contentIdentity: { status: "none", libraryMatches: [] },
            git: { status: "outside-git" },
            locks: [],
            skill_md_modified_at: "2026-09-20T12:00:00.000Z",
          },
        ],
        brokenLinks: [],
        suppressed: [],
      },
    }),
  ),
  resultStory(
    "doctor",
    "healthy",
    result("doctor", {
      listing_budgets: [doctorListingBudget],
      harnesses: [
        {
          harness: "claude-code",
          status: "checked",
          cwd: "/home/story/project",
          version: "2.1.284",
          coverage: "callable-commands",
          limitations: [
            "Callable commands only; file paths and non-user-invocable skills are not exposed.",
          ],
          skills: [{ name: "review", description: "Review changes", warnings: [], errors: [] }],
          warnings: [],
        },
        {
          harness: "opencode",
          status: "checked",
          cwd: "/home/story/project",
          version: "1.18.18",
          coverage: "resolved-skills",
          limitations: ["Resolved list; duplicate names may replace earlier entries."],
          skills: [
            {
              name: "review",
              path: "/home/story/.agents/skills/review/SKILL.md",
              warnings: [],
              errors: [],
            },
          ],
          warnings: [],
        },
        {
          harness: "devin",
          status: "missing",
          cwd: "/home/story/project",
          coverage: "native-skills",
          detail: "Executable not found on PATH: devin",
          limitations: [],
          skills: [],
          warnings: [],
        },
      ],
      ok: true,
      issues: [],
      codex: {
        status: "checked",
        cwd: "/home/story/project",
        version: "0.159.2",
        instances: [],
        findings: [],
        errors: [],
      },
    }),
  ),
  resultStory(
    "doctor",
    "duplicate-skills",
    result("doctor", {
      listing_budgets: [doctorListingBudget],
      ok: true,
      issues: [],
      codex: {
        status: "checked",
        cwd: "/home/story/project",
        version: "0.159.2",
        errors: [],
        instances: [
          {
            name: "review",
            displayName: "Review",
            path: "/home/story/.agents/skills/review/SKILL.md",
            canonicalPath: "/home/story/.agents/skills/review/SKILL.md",
            scope: "user",
            skitManaged: true,
            documentDigest: digest,
          },
          {
            name: "review",
            displayName: "Review",
            path: "/home/story/.codex/skills/review/SKILL.md",
            canonicalPath: "/home/story/Work/skills/review/SKILL.md",
            scope: "user",
            skitManaged: false,
            documentDigest: digest,
          },
        ],
        findings: [
          {
            kind: "duplicate-name",
            name: "review",
            documents: "identical",
            instances: [
              {
                name: "review",
                displayName: "Review",
                path: "/home/story/.agents/skills/review/SKILL.md",
                canonicalPath: "/home/story/.agents/skills/review/SKILL.md",
                scope: "user",
                skitManaged: true,
                documentDigest: digest,
              },
              {
                name: "review",
                displayName: "Review",
                path: "/home/story/.codex/skills/review/SKILL.md",
                canonicalPath: "/home/story/Work/skills/review/SKILL.md",
                scope: "user",
                skitManaged: false,
                documentDigest: digest,
              },
            ],
          },
        ],
      },
      harnesses: [
        {
          harness: "opencode",
          status: "checked",
          cwd: "/home/story/project",
          version: "1.18.18",
          coverage: "resolved-skills",
          limitations: [],
          skills: [
            {
              name: "review",
              path: "/home/story/.agents/skills/review/SKILL.md",
              warnings: [],
              errors: [],
            },
          ],
          warnings: [
            'timestamp=2026-09-30T20:15:58Z level=WARN run=example message="duplicate skill name" name=review existing=/home/story/.claude/skills/review/SKILL.md duplicate=/home/story/.agents/skills/review/SKILL.md',
          ],
        },
      ],
    }),
  ),
  resultStory(
    "doctor",
    "projection-conflict",
    result("doctor", {
      listing_budgets: [
        {
          _tag: "Unavailable",
          harness: "codex",
          cwd: "/home/story/project",
          detail: "Codex CLI is unavailable",
        },
      ],
      harnesses: [],
      ok: false,
      codex: {
        status: "missing",
        cwd: "/home/story/project",
        detail: "Codex CLI is unavailable",
        instances: [],
        findings: [],
        errors: [],
      },
      issues: [
        {
          code: "PROJECTION_CONFLICT",
          skillId,
          path: "/home/story/.agents/skills/review",
          target: "agents",
        },
      ],
    }),
  ),
  resultStory(
    "auth-status",
    "signed-out",
    result("authStatus", {
      credentials: [],
    }),
  ),
  resultStory(
    "auth-status",
    "signed-in",
    result("authStatus", {
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
          storage: "keychain",
        },
      ],
    }),
  ),
  resultStory("registry-list", "empty", result("registryList", { registries: [] })),
  resultStory(
    "registry-list",
    "configured",
    result("registryList", {
      registries: [
        { name: "public", origin: "https://registry.example", isDefault: true },
        { name: "team", origin: "https://skills.example", isDefault: false },
      ],
    }),
  ),
  resultStory(
    "check",
    "current",
    result("check", [
      {
        subject_id: collectionId,
        subject_kind: "collection",
        label: "review-tools",
        collection_versions: [
          { collection_version_id: collectionVersionId, digest, original_intact: true },
        ],
        unresolved_skill_selections: 0,
        source_status: "unverified",
        has_imports: true,
      },
    ]),
  ),
  resultStory(
    "update",
    "available",
    result("updatePlan", [
      {
        subject_id: collectionId,
        subject_kind: "collection",
        current_snapshot_digest: digest,
        available_snapshot_digest: `sha256:${"1".repeat(64)}`,
        changed: true,
        label: "review-tools",
        enabled: ["release-notes"],
        new_available: 0,
        updated: ["review"],
        removed: [],
        kept: ["triage"],
      },
    ]),
  ),
  resultStory(
    "update",
    "applied",
    result("update", [
      {
        subject_id: collectionId,
        subject_kind: "collection",
        previous_collection_version_id: versionId,
        selected_collection_version_id: otherVersionId,
        snapshot_digest: `sha256:${"1".repeat(64)}`,
        changed: true,
        installed: 1,
        label: "review-tools",
        enabled: ["release-notes"],
        new_available: 12,
        updated: ["review"],
        removed: ["legacy-review"],
        kept: [],
      },
    ]),
  ),
  resultStory(
    "update-projection",
    "preview",
    result("projectionRetentionPlan", {
      revision: "library-revision-story",
      skill_id: skillId,
      skill_name: "review",
      previous_skill_version_id: skillVersionId,
      selected_installed_skill_id: installedSkillId,
      observed_digest: digest,
      snapshot_digest: digest,
      original_path: `/home/story/.skit/originals/${digest}`,
      import_required: true,
      installed_skills: [
        {
          installed_skill_id: installedSkillId,
          destination: "agents",
          path: "/home/story/.agents/skills/review",
          observed_digest: digest,
          agreement: "selected",
        },
      ],
    }),
  ),
  resultStory(
    "update-projection",
    "retained",
    result("projectionRetention", {
      skill_id: skillId,
      skill_name: "review",
      previous_skill_version_id: skillVersionId,
      imported_skill_version_id: makeSkillVersionId(),
      collection_version_id: collectionVersionId,
      snapshot_digest: digest,
      imported: true,
      installed_skills: [
        {
          installed_skill_id: installedSkillId,
          destination: "agents",
          path: "/home/story/.agents/skills/review",
          status: "installed",
        },
      ],
    }),
  ),
  resultStory(
    "remove",
    "preview",
    result("removePlan", {
      subject_id: collectionId,
      subject_kind: "collection",
      versions: 1,
      skills: 1,
      global_enabled: 1,
      repositories: 0,
      installed_skills: 1,
    }),
  ),
  resultStory(
    "remove",
    "applied",
    result("remove", {
      subject_id: collectionId,
      subject_kind: "collection",
      versions: 1,
      skills: 1,
      global_enabled: 1,
      repositories: 0,
      installed_skills: 1,
      uninstalled: 1,
    }),
  ),
  resultStory(
    "enable",
    "preview",
    result("enablePlan", {
      subject_id: collectionId,
      skills: ["review"],
      scope: { kind: "global" },
      action: "enable",
      changed: true,
      enabled,
    }),
  ),
  resultStory(
    "enable",
    "applied",
    result("enable", {
      application: { intent: "saved", status: "complete", revision: "0".repeat(64) },
      subject_id: collectionId,
      skills: ["review"],
      scope: { kind: "global" },
      action: "enable",
      changed: true,
      enabled,
      installed_skills: [
        { destination: "agents", path: "/home/story/.agents/skills/review", status: "installed" },
      ],
    }),
  ),
  resultStory(
    "disable",
    "preview",
    result("disablePlan", {
      subject_id: collectionId,
      skills: ["review"],
      scope: { kind: "global" },
      action: "disable",
      changed: true,
      enabled: [],
    }),
  ),
  resultStory(
    "disable",
    "applied",
    result("disable", {
      application: { intent: "saved", status: "complete", revision: "0".repeat(64) },
      subject_id: collectionId,
      skills: ["review"],
      scope: { kind: "global" },
      action: "disable",
      changed: true,
      enabled: [],
      installed_skills: [],
    }),
  ),
  resultStory(
    "publish",
    "release",
    result("publish", {
      release: {
        release_id: "release-1",
        version: "1.2.0",
        revision_id: "draft-7",
        archive_digest: digest,
        download_path: "/api/skits/smol-ai/review-tools/releases/1.2.0",
      },
    }),
  ),
  resultStory(
    "sync",
    "first-sync-ready",
    result("sync", {
      status: "first_sync_ready",
      changed: true,
      identity: {
        authority: "registry.example",
        namespace: "smol-ai",
        skit: "review-tools",
        locator: "registry.example/smol-ai/review-tools",
      },
      visibility: "private",
      file_count: 3,
      effects: ["create_skit", "create_draft", "record_remote_home"],
    }),
  ),
  resultStory(
    "sync",
    "conflicted",
    result("sync", {
      status: "conflicted",
      changed: false,
      conflicts: [{ path: "SKIT.md", kind: "both_modified" }],
    }),
  ),
  resultStory(
    "library-sync",
    "merged",
    result("librarySync", {
      status: "merged",
      changed: true,
      revision_id: "revision-story",
      snapshots: 1,
      installed: 1,
    }),
  ),
  resultStory(
    "server-bootstrap",
    "complete",
    result("serverBootstrap", {
      origin: "https://registry.example",
      status: "complete",
    }),
  ),
  resultStory(
    "server-bootstrap",
    "already-complete",
    result("serverBootstrap", {
      origin: "https://registry.example",
      status: "already_complete",
    }),
  ),
  resultStory(
    "auth-login",
    "authenticated",
    result("authLogin", {
      origin: "https://registry.example",
      tokenPrefix: "sk_live_…",
      scopes: ["publish", "draft:write"],
      expiresAt: "2027-01-01T00:00:00Z",
    }),
  ),
  resultStory(
    "auth-login",
    "pending-approval",
    result("authLoginPending", {
      origin: "https://registry.example",
      userCode: "ABCD-EFGH",
      verificationUri: "https://registry.example/device",
      expiresAt: "2027-01-01T00:10:00.000Z",
      next: "skit auth login",
    }),
  ),
  resultStory(
    "auth-logout",
    "revoked",
    result("authLogout", {
      origin: "https://registry.example",
      revoked: true,
    }),
  ),
  resultStory(
    "registry",
    "added",
    result("registryRemote", {
      action: "added",
      name: "team",
      origin: "https://registry.example",
      isDefault: false,
    }),
  ),
  resultStory(
    "harness-probe",
    "mixed",
    result("experimentalHarnessProbe", {
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
  ),
  resultStory(
    "audit",
    "empty-v1alpha4",
    result("experimentalAuditV1Alpha4", {
      schemaVersion: "v1alpha4",
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
  ),
  resultStory(
    "audit",
    "findings-v1alpha4",
    result("experimentalAuditV1Alpha4", {
      schemaVersion: "v1alpha4",
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
  ),
  failureStory("not-found", {
    code: "NOT_FOUND",
    exitCode: 11,
    message: "The requested Library Entry does not exist",
    remediation: "Run `skit list` and choose an existing Collection Reference.",
  }),
  failureStory("projection-conflict", {
    code: "CONFLICT",
    exitCode: 12,
    message: "The install destination contains content SKIT does not own",
    remediation: "Run `skit doctor` and fix the conflicting installed skill.",
  }),
];

export const outputStoryKey = (story: OutputStory): string => `${story.group}/${story.name}`;
