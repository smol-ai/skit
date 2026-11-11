import { RegistryTransportError } from "../registry/request-failures.js";
import { ArchiveStreamInvalid, SkitValidationFailed } from "@smolai/skit-core/universal/consumer";
import { TreeError } from "@smolai/skit-core/shared";
import { GitInspectionFailed } from "@smolai/skit-core/library/update/failures";
import { SetupPlanStale } from "@smolai/skit-core/library/setup/failures";
import {
  BootstrapCleanupFailed,
  BootstrapExternalFailure,
  BootstrapConfigInvalid,
} from "../registry/bootstrap-failures.js";
import { HelpDocumentMissing } from "../commands/help-failures.js";
import { UpdateCheckTimedOut } from "../platform/release-failures.js";
import { FindingFingerprintInvalid } from "../library/security/failures.js";
import {
  LibrarySubjectNotFound,
  LibraryManifest,
  InvalidLibraryState,
  ContentAddressCollision,
  LibraryChanged,
  UninstallConflict,
  RecoveryInvalid,
  SetupImportInvalid,
  InstalledSkillInvalid,
} from "@smolai/skit-core/library";
import { SourceRestoreInvalid } from "@smolai/skit-core/library/source-restore/failures";
import { systemError } from "effect/PlatformError";
import {
  CommandLineInvalid,
  MissingRequirement,
  OptionCombinationInvalid,
} from "../commands/input-failures.js";
import { PromptCancelled, NothingToSelect } from "../terminal/interaction-failures.js";
import {
  RegistrySelectionAmbiguous,
  CredentialLacksScope,
  CredentialsUnusable,
  AuthorSyncRequired,
  SignInFailed,
  SignInRejected,
  SignOutRejected,
} from "../registry/failures.js";
import { CliError } from "effect/cli";
import {
  LibraryApiInvalidResponse,
  LibraryApiRejected,
  PublicationResponseError,
  AuthorRequestTimedOut,
} from "../registry/request-failures.js";
import { registryContractFailure } from "../registry/api-client.js";
import { StepSchemaFailure, StepDefect } from "@smolai/skit-core/library/recorded-failures";
import { UpdateSelectionMissing } from "@smolai/skit-core/library/setup/failures";
import { SetupStopped } from "@smolai/skit-core/library/setup";
import {
  classifyFailure,
  commandFailure,
  commandError,
} from "../commands/failure-classification.js";
import { HarnessDiscoveryFailed } from "@smolai/skit-core/harnesses/discovery-failures";
import {
  SourceProcessTimedOut,
  CommandFailed,
  SourcePolicyViolation,
} from "@smolai/skit-core/library/source/failures";
import { LocalFilesChangedDuringSync, PublicationBlocked } from "@smolai/skit-core/author/failures";
import { emptyUsageStory, usageStory } from "./usage-stories.js";
import {
  makeCollectionId,
  makeOperationId,
  makeInstalledSkillId,
  makeCollectionVersionId,
  makeSkillId,
  makeSkillVersionId,
} from "@smolai/skit-core/universal/consumer";
import * as History from "@smolai/skit-core/history";
import { estimateCodexListing } from "@smolai/skit-core/harnesses";
import { Cause, Data, Result, Schema } from "effect";

import type { CommandFailure, CommandResult } from "../commands/types.js";
import { result } from "../commands/result.js";
import { recoveryActions } from "../library/recovery/output.js";
import { setupUndoActions } from "../library/setup.js";

export type OutputStory = Data.TaggedEnum<{
  Result: {
    readonly name: string;
    readonly group: string;
    readonly result: CommandResult;
    readonly scenario?: {
      readonly initial: string;
      readonly trigger: string;
      readonly result: string;
    };
    /** Commands this example demonstrates when a shared contract has different command behaviours. */
    readonly commands?: readonly string[];
  };
  Failure: { readonly name: string; readonly group: string; readonly failure: CommandFailure };
}>;

export const OutputStory = Data.taggedEnum<OutputStory>();

/** The home directory output stories are drawn for; story paths live under it. */
export const storyHome = "/home/story";

const resultStory = (
  group: string,
  name: string,
  result: CommandResult,
  commands?: readonly string[],
): OutputStory =>
  OutputStory.Result({ group, name, result, ...(commands === undefined ? {} : { commands }) });

const failureStory = (name: string, failure: CommandFailure): OutputStory =>
  OutputStory.Failure({ group: "failure", name, failure });

const hash = `sha256:${"0".repeat(64)}`;
const rawSchemaIssue = () => {
  const decoded = Schema.decodeUnknownResult(
    Schema.Struct({ scope: Schema.Struct({ enabled: Schema.Boolean }) }),
  )({ scope: { enabled: "yes" } });
  if (Result.isSuccess(decoded)) throw new Error("Expected invalid enabled data");
  return decoded.failure.issue;
};
const collectionId = makeCollectionId();
const versionId = makeCollectionVersionId();
const otherVersionId = makeCollectionVersionId();
const skillVersionId = makeSkillVersionId();
const skillId = makeSkillId();
const invalidCollectionIdentifier = () => {
  const decoded = Schema.decodeResult(LibraryManifest)({
    schema: "skit.library.v8",
    collections: [{ collection_id: "review-tools", label: "Review tools" }],
    skills: [],
    collection_versions: [],
    imports: [],
    snapshot_digests: [],
    enabled: [],
  });
  if (Result.isSuccess(decoded)) throw new Error("Expected an invalid collection identifier");
  return new InvalidLibraryState({
    path: `${storyHome}/.skit/state.json`,
    reason: { _tag: "SchemaInvalid", failure: decoded.failure },
  });
};
const missingEnabledSubject = () => {
  const decoded = Schema.decodeResult(LibraryManifest)({
    schema: "skit.library.v8",
    collections: [],
    skills: [],
    collection_versions: [],
    imports: [],
    snapshot_digests: [],
    enabled: [{ skill: skillId }],
  });
  if (Result.isSuccess(decoded)) throw new Error("Expected an invalid story manifest");
  return new InvalidLibraryState({
    path: `${storyHome}/.skit/state.json`,
    reason: { _tag: "SchemaInvalid", failure: decoded.failure },
  });
};
const overlappingMergedSkills = () => {
  const decoded = Schema.decodeResult(LibraryManifest)({
    schema: "skit.library.v8",
    collections: [{ collection_id: collectionId, label: "review-tools" }],
    skills: [
      {
        skill_id: skillId,
        collection_id: collectionId,
        path: "review",
        name: "review",
        versions: [],
      },
      {
        skill_id: makeSkillId(),
        collection_id: collectionId,
        path: "review/child",
        name: "child",
        versions: [],
      },
    ],
    collection_versions: [],
    imports: [],
    snapshot_digests: [],
    enabled: [],
  });
  if (Result.isSuccess(decoded)) throw new Error("Expected overlapping merged Skill paths");
  return decoded.failure;
};
const collectionVersionId = makeCollectionVersionId();
const installedSkillId = makeInstalledSkillId();
const enabled = [{ skill: skillId }];
// Real Collections pinned in test/fixtures/collections/full-manifest.json.
const syncCollections = {
  swyxio: makeCollectionId(),
  asmartbear: makeCollectionId(),
  nvidia: makeCollectionId(),
};
// NVIDIA/skills ships nvidia-skill-finder twice: under skills/ and plugins/nvidia-skills/skills/.
const pluginSkillId = makeSkillId();
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
  cwd: "/home/story/work/review-tools",
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

const setupStoryInstance = {
  name: "review",
  path: "/home/story/.claude/skills/review",
  aliases: ["/home/story/.claude/skills/review"],
  scope: "global",
  harnesses: ["claude-code"],
  owner: { kind: "unknown" },
  contentIdentity: {
    status: "hashed",
    currentHash: `sha256:${"a".repeat(64)}`,
    libraryMatches: [],
  },
  git: { status: "outside-git" },
  locks: [],
} as const;

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
    "completions",
    "bash",
    result("completions", {
      shell: "bash",
      script: "# Bash completion for skit\ncomplete -W 'add list sync' skit\n",
    }),
  ),
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
      path: "/home/story/work/review-tools",
      library_registration: "registered",
    }),
  ),
  resultStory(
    "author-init",
    "discovered-skills",
    result("init", {
      path: "/home/story/work/review-tools",
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
      identity: { slug: "review-tools", release: "1.2.0", releaseContentHash: hash, skills: [] },
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
      identity: { slug: "review-tools", release: "1.2.0", releaseContentHash: hash, skills: [] },
      diagnostics: [
        {
          code: "SECURITY_ASSESSMENT_WARNING",
          severity: "warning",
          assessment: {
            context: "author",
            outcome: "warn",
            reasons: [{ code: "UNDECLARED_CAPABILITY", ruleIds: [], capabilityIds: ["network"] }],
            findingDecisions: [],
          },
          path: "skills/review/SKILL.md",
        },
      ],
      audits: {},
      assessments: {},
    }),
  ),
  resultStory(
    "validate",
    "policy-blocked",
    result("validate", {
      valid: false,
      status: "policy-blocked",
      identity: { slug: "review-tools", release: "1.2.0", releaseContentHash: hash, skills: [] },
      diagnostics: [
        {
          code: "SECURITY_POLICY_BLOCKED",
          severity: "error",
          assessment: {
            context: "publish",
            outcome: "block",
            reasons: [{ code: "CRITICAL_EVIDENCE", ruleIds: [], capabilityIds: [] }],
            findingDecisions: [],
          },
          path: "skills/review/SKILL.md",
        },
      ],
      audits: {},
      assessments: {},
    }),
  ),
  resultStory(
    "validate",
    "invalid",
    result("validate", {
      valid: false,
      status: "invalid",
      identity: { slug: "review-tools", release: "1.2.0", releaseContentHash: hash, skills: [] },
      diagnostics: [
        {
          code: "SKILL_FILE_MISSING",
          severity: "error",
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
      path: "/home/story/work/review-tools",
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
          current_revision_id: History.RevisionId.make(`sha256:${"7".repeat(64)}`),
          current_revision_published: true,
          most_recent_release_version: "1.2.0",
        },
        {
          identity: "https://registry.example/smol-ai/triage-tools",
          visibility: "private",
          current_revision_id: History.RevisionId.make(`sha256:${"3".repeat(64)}`),
          current_revision_published: false,
          most_recent_release_version: null,
        },
      ],
    }),
  ),
  resultStory(
    "author-delete",
    "delete-ready",
    result("authorDelete", {
      status: "delete_ready",
      skit_id: "smol-ai/review-tools",
      changed: false,
      revisions: 2,
      releases: 1,
      release_versions: ["1.2.0"],
    }),
  ),
  resultStory(
    "author-delete",
    "absent",
    result("authorDelete", {
      status: "absent",
      skit_id: "smol-ai/review-tools",
      changed: false,
      revisions: 0,
      releases: 0,
      release_versions: [],
    }),
  ),
  resultStory(
    "author-delete",
    "deleted",
    result("authorDelete", {
      status: "deleted",
      skit_id: "smol-ai/review-tools",
      changed: true,
      revisions: 2,
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
        snapshot_digest: hash,
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
  OutputStory.Result({
    group: "add",
    name: "plugin-declaration-warning",
    scenario: {
      initial:
        "The Source contains a valid review Skill and a marketplace entry that repeats its plugin's skills field under strict:false.",
      trigger: "Inspect the Source before importing it.",
      result:
        "SKIT reports the conflicting marketplace declaration and still offers the discovered review Skill.",
    },
    result: result("addPreview", {
      kind: "plain",
      skills: [{ name: "review", verbatim_path: "tools/skills/review" }],
      diagnostics: [
        {
          code: "plugin-manifest-invalid",
          path: "tools/.claude-plugin/plugin.json",
          reason: { _tag: "MarketplaceComponentsConflict", fields: ["skills"] },
        },
      ],
    }),
  }),
  OutputStory.Result({
    group: "update",
    name: "plugin-member-held",
    scenario: {
      initial:
        "The Collection contains review from skills/review. The Source adds a different Skill with the same name at plugins/tools/skills/review.",
      trigger: "Preview updating the Collection.",
      result:
        "SKIT keeps the existing member and identifies the conflicting candidate it left unselected. The Collection is unchanged.",
    },
    result: result("updatePlan", [
      {
        subject_id: collectionId,
        subject_kind: "collection",
        label: "review-tools",
        current_snapshot_digest: hash,
        available_snapshot_digest: hash,
        changed: false,
        enabled: [],
        new_available: 0,
        updated: [],
        removed: [],
        kept: [],
        diagnostics: [
          {
            code: "plugin-member-held",
            path: "plugins/tools/skills/review",
            skillName: "review",
            retainedPath: "skills/review",
          },
        ],
      },
    ]),
  }),
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
              versions: [{ skill_version_id: skillVersionId, artifact_hash: hash }],
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
      artifactContentHash: hash,
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
      artifactContentHash: hash,
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
        repositoryRoots: ["/home/story/work"],
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
      repositories: [
        { path: "/home/story/work/review-tools", skills: ["review"], status: "undecided" },
      ],
      repositoryConfigs: [],
      authoredCollections: [],
      installedSkills: [],
      collectionGroups: {
        sources: [],
        repositories: [],
        loose: [setupStoryInstance],
        installed: [],
        authored: [],
      },
      onboarding: {
        planId: `sha256:${"0".repeat(64)}`,
        apply: { repositoryRoots: ["/home/story/work"], needsDuplicateDecision: false },
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
      instances: [setupStoryInstance],
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
      planId: hash,
      reviewId: hash,
      hasChanges: true,
      canApply: true,
      summary: {
        sourceUpdateMayNeedReview: false,
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
      planId: hash,
      copies: [
        {
          name: "review",
          path: "/home/story/.claude/skills/review",
          currentHash: hash,
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
      ...commandError(
        Cause.fail(
          new SetupPlanStale({ approvedPlanId: hash, currentPlanId: `sha256:${"1".repeat(64)}` }),
        ),
      ),
      actions: [],
    }),
  ),
  resultStory(
    "setup",
    "undo-conflicted",
    result("setupUndo", {
      operationId: "story-operation",
      planId: hash,
      files: [{ path: "/home/story/.codex/skills/review", kind: "restore" }],
      intentChanged: true,
      settingsChanged: false,
      sourceSelections: [],
      actions: setupUndoActions("/home/story/.skit", "story-operation", hash),
      status: "conflicted",
      phase: "preview",
      conflicts: [{ _tag: "ParentChanged", path: "/home/story/.codex/skills/review" }],
    }),
  ),
  resultStory(
    "setup",
    "undo-applied",
    result("setupUndo", {
      operationId: "story-operation",
      planId: hash,
      files: [{ path: "/home/story/.codex/skills/review", kind: "restore" }],
      intentChanged: true,
      settingsChanged: false,
      sourceSelections: [],
      actions: setupUndoActions("/home/story/.skit", "story-operation", hash),
      status: "undone",
      phase: "applied",
      conflicts: [],
    }),
  ),
  resultStory(
    "setup",
    "undo-already-undone",
    result("setupUndo", {
      operationId: "story-operation",
      planId: hash,
      files: [{ path: "/home/story/.codex/skills/review", kind: "restore" }],
      intentChanged: true,
      settingsChanged: false,
      sourceSelections: [],
      actions: setupUndoActions("/home/story/.skit", "story-operation", hash),
      status: "already-undone",
      phase: "preview",
      conflicts: [],
    }),
  ),
  resultStory(
    "setup",
    "undo-preview",
    result("setupUndo", {
      operationId: "story-operation",
      planId: hash,
      status: "ready",
      phase: "preview",
      conflicts: [],
      files: [{ path: "/home/story/.codex/skills/review", kind: "restore" }],
      intentChanged: true,
      settingsChanged: false,
      sourceSelections: [],
      actions: setupUndoActions("/home/story/.skit", "story-operation", hash),
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
      planId: hash,
      entries: [
        {
          name: "review",
          path: "/home/story/.codex/skills/review",
          recoveryPath: "/home/story/.skit/removed/story-operation/batch/review",
          type: "SymbolicLink",
          status: "saved",
          reason: "saved",
        },
      ],
      legacy: false,
      phase: "inspection",
      actions: recoveryActions("/home/story/.skit", "story-operation"),
    }),
  ),
  resultStory(
    "repository",
    "list",
    result("repositoryPolicy", {
      action: "list",
      path: "",
      repositories: [
        { path: "/home/story/work/review-tools", status: "watched" },
        { path: "/home/story/work/scratch", status: "ignored" },
      ],
    }),
    ["repository list"],
  ),
  resultStory(
    "repository",
    "list-empty",
    result("repositoryPolicy", { action: "list", path: "", repositories: [] }),
    ["repository list"],
  ),
  resultStory(
    "repository",
    "watch",
    result("repositoryPolicy", {
      action: "watch",
      path: "/home/story/work/review-tools",
      repositories: [{ path: "/home/story/work/review-tools", status: "watched" }],
    }),
    ["repository watch"],
  ),
  resultStory(
    "repository",
    "ignore",
    result("repositoryPolicy", {
      action: "ignore",
      path: "/home/story/work/scratch",
      repositories: [{ path: "/home/story/work/scratch", status: "ignored" }],
    }),
    ["repository ignore"],
  ),
  resultStory(
    "repository",
    "forget",
    result("repositoryPolicy", {
      action: "forget",
      path: "/home/story/work/review-tools",
      repositories: [],
    }),
    ["repository forget"],
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
    "harness-owned-origins",
    result("inventory", {
      skills: [],
      installed_skills: [],
      unmanaged: [],
      machine: {
        repositoryRoots: [],
        repositoryDecisions: [],
        scan: { complete: true, directoriesExamined: 4, repositorySearchDepth: 1 },
        instances: (
          [
            ["system", `${storyHome}/.codex/skills/.system`],
            [
              "bundled-plugin",
              `${storyHome}/.codex/plugins/cache/openai-bundled/example/1.0.0/skills`,
            ],
            [
              "runtime-plugin",
              `${storyHome}/.codex/plugins/cache/openai-primary-runtime/example/1.0.0/skills`,
            ],
            [
              "curated-plugin",
              `${storyHome}/.codex/plugins/cache/openai-curated-remote/example/1.0.0/skills`,
            ],
          ] as const
        ).map(([origin, directory]) => ({
          ...setupStoryInstance,
          name: `review-${origin}`,
          path: `${directory}/review-${origin}`,
          aliases: [],
          harnesses: ["codex"],
          owner: { kind: "harness", harness: "codex", origin },
          skill_md_modified_at: null,
        })),
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
            contentIdentity: {
              status: "hashed",
              currentHash: `sha256:${"a".repeat(64)}`,
              libraryMatches: [],
            },
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
            contentIdentity: {
              status: "hashed",
              currentHash: `sha256:${"a".repeat(64)}`,
              libraryMatches: [],
            },
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
          findings: [],
          status: "checked",
          cwd: "/home/story/work/review-tools",
          version: "2.1.284",
          coverage: "callable-commands",
          protocol: "claude-control-initialize",
          skills: [{ name: "review", description: "Review changes", warnings: [], errors: [] }],
          warnings: [],
        },
        {
          harness: "opencode",
          findings: [],
          status: "checked",
          cwd: "/home/story/work/review-tools",
          version: "1.18.18",
          coverage: "resolved-skills",
          protocol: "opencode-debug-skill",
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
          findings: [],
          status: "missing",
          cwd: "/home/story/work/review-tools",
          coverage: "native-skills",
          probeFailure: { _tag: "ExecutableMissing", command: "devin" },
          skills: [],
          warnings: [],
        },
      ],
      ok: true,
      issues: [],
      codex: {
        status: "checked",
        cwd: "/home/story/work/review-tools",
        version: "0.159.2",
        instances: [],
        findings: [],
        errors: [],
      },
    }),
  ),
  ...[
    {
      name: "discovery-wrong-directory",
      reason: {
        _tag: "DirectoryMismatch" as const,
        endpoint: "/api/plugin",
        expected: "/home/story/work/review-tools",
        actual: "/home/story/work/other",
      },
      initial: "OpenCode is installed. No model session is running.",
      trigger:
        "Doctor asks OpenCode for the inventory of review-tools, but its server returns another directory.",
      observed: "Doctor names both directories and leaves all skills untouched.",
    },
    {
      name: "discovery-http-failure",
      reason: { _tag: "HttpStatus" as const, endpoint: "/api/plugin", status: 500 },
      initial: "OpenCode is installed and its discovery server starts.",
      trigger: "Doctor requests plugin status, and the server returns HTTP 500.",
      observed:
        "Doctor reports the failed endpoint and HTTP status instead of an empty healthy inventory.",
    },
  ].map(({ name, reason, initial, trigger, observed }) =>
    OutputStory.Result({
      group: "doctor",
      name,
      scenario: { initial, trigger, result: observed },
      result: result("doctor", {
        listing_budgets: [],
        ok: true,
        issues: [],
        codex: {
          status: "checked",
          cwd: "/home/story/work/review-tools",
          instances: [],
          findings: [],
          errors: [],
        },
        harnesses: [
          {
            harness: "opencode",
            cwd: "/home/story/work/review-tools",
            status: "failed",
            version: "2.0.20",
            protocol: "opencode-http-v2",
            coverage: "resolved-skills",
            skills: [],
            warnings: [],
            findings: [],
            discoveryFailure: new HarnessDiscoveryFailed({
              harness: "opencode",
              cwd: "/home/story/work/review-tools",
              reason,
            }),
          },
        ],
      }),
    }),
  ),
  OutputStory.Result({
    group: "doctor",
    name: "codex-config-rejected",
    scenario: {
      initial: "Codex is installed and can list enabled skills.",
      trigger:
        "Doctor requests Codex configuration to estimate the skill listing budget; config/read is rejected.",
      result: "Doctor keeps the native skill inventory and explains why its budget is unavailable.",
    },
    result: result("doctor", {
      ok: true,
      issues: [],
      harnesses: [],
      codex: {
        status: "checked",
        cwd: "/home/story/work/review-tools",
        version: "0.159.2",
        instances: [],
        findings: [],
        errors: [],
      },
      listing_budgets: [
        {
          _tag: "Unavailable",
          harness: "codex",
          cwd: "/home/story/work/review-tools",
          reason: {
            _tag: "DiscoveryFailed",
            failure: new HarnessDiscoveryFailed({
              harness: "codex",
              cwd: "/home/story/work/review-tools",
              reason: {
                _tag: "RemoteError",
                method: "config/read",
                diagnostic: "not supported by this build",
              },
            }),
          },
        },
      ],
    }),
  }),
  OutputStory.Result({
    group: "doctor",
    name: "listing-budget-provenance",
    scenario: {
      initial: "One Codex skill contributes to the native listing estimate.",
      trigger: "Atlas renders the doctor report with full detail.",
      result: "The report explains the model, context inputs and limits of the estimate.",
    },
    result: {
      ...result("doctor", {
        ok: true,
        issues: [],
        harnesses: [],
        listing_budgets: [doctorListingBudget],
        codex: {
          status: "checked",
          protocol: "codex-app-server",
          cwd: "/home/story/work/review-tools",
          instances: [
            {
              name: "review",
              displayName: "Review",
              path: "/home/story/.agents/skills/review/SKILL.md",
              canonicalPath: "/home/story/.agents/skills/review/SKILL.md",
              scope: "user",
              skitManaged: false,
            },
          ],
          findings: [],
          errors: [],
        },
      }),
      detail: "full",
    },
  }),
  OutputStory.Result({
    group: "doctor",
    name: "custom-roots",
    scenario: {
      initial: "Inventory is using custom Codex and Claude skill directories.",
      trigger: "Run doctor with --codex-root and --claude-root overrides.",
      result:
        "Doctor keeps the supplied paths and explains why native discovery was skipped for those harnesses.",
    },
    result: result("doctor", {
      ok: true,
      issues: [],
      listing_budgets: [
        {
          _tag: "Unavailable",
          harness: "codex",
          cwd: "/home/story/work/review-tools",
          reason: { _tag: "CustomRoot", roots: ["/home/story/custom/codex"] },
        },
      ],
      codex: {
        status: "skipped",
        cwd: "/home/story/work/review-tools",
        rootOverrides: ["/home/story/custom/codex"],
        instances: [],
        findings: [],
        errors: [],
      },
      harnesses: [
        {
          harness: "claude-code",
          status: "skipped",
          cwd: "/home/story/work/review-tools",
          rootOverrides: ["/home/story/custom/claude"],
          coverage: "callable-commands",
          skills: [],
          warnings: [],
          findings: [],
        },
      ],
    }),
  }),
  resultStory(
    "doctor",
    "duplicate-skills",
    result("doctor", {
      listing_budgets: [doctorListingBudget],
      ok: true,
      issues: [],
      codex: {
        status: "checked",
        cwd: "/home/story/work/review-tools",
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
            documentHash: hash,
          },
          {
            name: "review",
            displayName: "Review",
            path: "/home/story/.codex/skills/review/SKILL.md",
            canonicalPath: "/home/story/Work/skills/review/SKILL.md",
            scope: "user",
            skitManaged: false,
            documentHash: hash,
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
                documentHash: hash,
              },
              {
                name: "review",
                displayName: "Review",
                path: "/home/story/.codex/skills/review/SKILL.md",
                canonicalPath: "/home/story/Work/skills/review/SKILL.md",
                scope: "user",
                skitManaged: false,
                documentHash: hash,
              },
            ],
          },
        ],
      },
      harnesses: [
        {
          harness: "opencode",
          findings: [
            {
              _tag: "NameCollision",
              name: "review",
              paths: [
                "/home/story/.agents/skills/review/SKILL.md",
                "/home/story/.claude/skills/review/SKILL.md",
              ],
              selectedPath: "/home/story/.agents/skills/review/SKILL.md",
            },
          ],
          status: "checked",
          cwd: "/home/story/work/review-tools",
          version: "1.18.18",
          coverage: "resolved-skills",
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
  ...[
    {
      name: "installed-files-edited",
      conflicts: [
        {
          _tag: "ContentChanged" as const,
          baseline: "marker" as const,
          expected: hash,
          actual: `sha256:${"1".repeat(64)}`,
        },
      ],
      initial: "SKIT installed the review skill with a valid ownership marker.",
      trigger: "Edit the installed SKILL.md, then run skit inventory and skit doctor.",
      result: "Doctor reports changed installed files. SKIT leaves the edit untouched.",
    },
    {
      name: "ownership-marker-missing",
      conflicts: [{ _tag: "MarkerMissing" as const }],
      initial: "SKIT installed the review skill and recorded its location.",
      trigger:
        "Remove .skit-ownership.json from the installed folder, then run skit inventory and skit doctor.",
      result: "Doctor reports the missing ownership marker. The folder is left untouched.",
    },
    {
      name: "ownership-marker-invalid",
      conflicts: [{ _tag: "MarkerInvalid" as const, reason: { _tag: "InvalidJson" as const } }],
      initial: "SKIT installed the review skill and recorded its location.",
      trigger:
        "Replace .skit-ownership.json with invalid JSON, then run skit inventory and skit doctor.",
      result: "Doctor reports an invalid ownership marker. The folder is left untouched.",
    },
    {
      name: "ownership-marker-not-object",
      conflicts: [{ _tag: "MarkerInvalid" as const, reason: { _tag: "NotObject" as const } }],
      initial: "SKIT installed the review skill and recorded its location.",
      trigger: "Replace .skit-ownership.json with null, then run skit inventory and skit doctor.",
      result:
        "Doctor reports that the ownership marker must contain an object. The folder is left untouched.",
    },
    {
      name: "ownership-marker-invalid-fields",
      conflicts: [{ _tag: "MarkerInvalid" as const, reason: { _tag: "InvalidFields" as const } }],
      initial: "SKIT installed the review skill and recorded its location.",
      trigger:
        "Replace .skit-ownership.json with an empty object, then run skit inventory and skit doctor.",
      result:
        "Doctor reports that the marker's fields do not match a supported format. The folder is left untouched.",
    },
    {
      name: "ownership-skill-mismatch",
      conflicts: [{ _tag: "SkillMismatch" as const, expected: skillId, actual: pluginSkillId }],
      initial: "SKIT installed the review skill and recorded its identity.",
      trigger: "Change the marker to name another skill, then run skit inventory and skit doctor.",
      result: "Doctor identifies the different skill in the ownership marker.",
    },
    {
      name: "ownership-copy-mismatch",
      conflicts: [
        {
          _tag: "InstalledSkillMismatch" as const,
          expected: installedSkillId,
          actual: makeInstalledSkillId(),
        },
      ],
      initial: "SKIT installed the review skill and recorded this copy's identity.",
      trigger:
        "Change the marker to name another installed copy, then run skit inventory and skit doctor.",
      result: "Doctor identifies the different installed copy in the ownership marker.",
    },
    {
      name: "ownership-hash-mismatch",
      conflicts: [
        { _tag: "MarkerHashMismatch" as const, expected: hash, actual: `sha256:${"1".repeat(64)}` },
        {
          _tag: "ContentChanged" as const,
          baseline: "marker" as const,
          expected: `sha256:${"1".repeat(64)}`,
          actual: hash,
        },
      ],
      initial: "SKIT installed review. Its files still match the Library's recorded hash.",
      trigger: "Change only the marker's expected hash, then run skit inventory and skit doctor.",
      result: "Doctor reports both hash disagreements, without assuming the user edited the skill.",
    },
  ].map(({ name, conflicts, initial, trigger, result: observed }) =>
    OutputStory.Result({
      group: "doctor",
      name,
      scenario: { initial, trigger, result: observed },
      result: result("doctor", {
        listing_budgets: [],
        harnesses: [],
        ok: false,
        codex: {
          status: "checked",
          cwd: "/home/story/work/review-tools",
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
            conflicts,
          },
        ],
      }),
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
          scopes: ["publish", "skit:write"],
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
          { collection_version_id: collectionVersionId, hash: hash, original_intact: true },
        ],
        unresolved_skill_selections: 0,
        source_status: "current",
        has_imports: true,
      },
    ]),
  ),
  resultStory(
    "check",
    "tree-hash-only",
    result("check", [
      {
        subject_id: collectionId,
        subject_kind: "collection",
        label: "review-tools",
        collection_versions: [
          { collection_version_id: collectionVersionId, hash, original_intact: true },
        ],
        unresolved_skill_selections: 0,
        source_status: "current",
        has_imports: true,
        skills_sh: {
          checked_at: "2026-11-11T00:00:00.000Z",
          members: [
            {
              skill_name: "review",
              skill_path: "skills/review/SKILL.md",
              status: "unverifiable",
              hash_kind: "skillFolderHash",
              baseline_verification: "lock-only",
              reason: { _tag: "TreeHashCannotVerifyOriginalBytes" },
            },
          ],
        },
      },
    ]),
  ),
  resultStory(
    "check",
    "missing-ref",
    result("check", [
      {
        subject_id: collectionId,
        subject_kind: "collection",
        label: "review-tools",
        collection_versions: [
          { collection_version_id: collectionVersionId, hash, original_intact: true },
        ],
        unresolved_skill_selections: 0,
        source_status: "current",
        has_imports: true,
        skills_sh: {
          checked_at: "2026-11-11T00:00:00.000Z",
          members: [
            {
              skill_name: "review",
              status: "unverifiable",
              reason: {
                _tag: "RefUnavailable",
                ref: "release-not-pushed",
                failure: new GitInspectionFailed({
                  operation: "rev-parse",
                  reason: {
                    _tag: "ExitCode",
                    exitCode: 128,
                    stderr: "fatal: Needed a single revision",
                  },
                }),
              },
            },
          ],
        },
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
        current_snapshot_digest: hash,
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
    "source-failed",
    result("update", [
      {
        status: "failed",
        subject_id: collectionId,
        subject_kind: "collection",
        label: "review-tools",
        source: "https://git.example.com/review-tools",
        phase: "source",
        source_imported: false,
        error: commandError(
          Cause.fail(
            new CommandFailed({
              command: "git fetch origin",
              exitCode: 128,
              stderr:
                "fatal: the remote repository could not be read\nCheck access to the configured remote.",
            }),
          ),
        ),
      },
    ]),
  ),
  resultStory(
    "update",
    "install-failed-after-import",
    result("update", [
      {
        status: "failed",
        subject_id: collectionId,
        subject_kind: "collection",
        label: "review-tools",
        source: "https://git.example.com/review-tools",
        phase: "install",
        source_imported: true,
        error: commandError(
          Cause.fail(new UninstallConflict({ path: `${storyHome}/.agents/skills/review` })),
        ),
      },
    ]),
  ),
  resultStory(
    "update",
    "registry-sync-failed",
    result("update", [
      {
        subject_id: collectionId,
        subject_kind: "collection",
        previous_collection_version_id: versionId,
        selected_collection_version_id: otherVersionId,
        snapshot_digest: hash,
        changed: true,
        installed: 1,
        label: "review-tools",
        enabled: [],
        new_available: 0,
        updated: ["review"],
        removed: [],
        kept: [],
        sync_status: "failed",
        sync_error: commandError(
          Cause.fail(
            new CredentialLacksScope({
              origin: "https://registry.example.com",
              scope: "authoring:write",
              scopes: "library:sync,authoring:write",
            }),
          ),
        ),
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
    "update-installed-edit",
    "preview",
    result("installedEditPlan", {
      revision: "library-revision-story",
      skill_id: skillId,
      skill_name: "review",
      previous_skill_version_id: skillVersionId,
      selected_installed_skill_id: installedSkillId,
      current_hash: hash,
      snapshot_digest: hash,
      original_path: `/home/story/.skit/originals/${hash}`,
      import_required: true,
      installed_skills: [
        {
          installed_skill_id: installedSkillId,
          destination: "agents",
          path: "/home/story/.agents/skills/review",
          current_hash: hash,
          agreement: "selected",
        },
      ],
    }),
  ),
  resultStory(
    "update-installed-edit",
    "retained",
    result("installedEdit", {
      skill_id: skillId,
      skill_name: "review",
      previous_skill_version_id: skillVersionId,
      imported_skill_version_id: makeSkillVersionId(),
      collection_version_id: collectionVersionId,
      snapshot_digest: hash,
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
  OutputStory.Result({
    group: "disable",
    name: "removal-incomplete",
    commands: ["disable"],
    scenario: {
      initial: "The review Skill is enabled, with an installed copy SKIT owns.",
      trigger:
        "While disable is applying, the installed files change after SKIT saves the disabled choice and before it removes the folder.",
      result:
        "The Library choice remains saved. The result reports the failed removal and leaves the installed files untouched.",
    },
    result: result("disable", {
      application: {
        intent: "saved",
        status: "incomplete",
        revision: "0".repeat(64),
        failure: {
          code: "CONFLICT",
          cause: new UninstallConflict({ path: `${storyHome}/.agents/skills/review` }),
        },
      },
      subject_id: skillId,
      skills: ["review"],
      scope: { kind: "global" },
      action: "disable",
      changed: true,
      enabled: [],
      installed_skills: [
        { destination: "agents", path: `${storyHome}/.agents/skills/review`, status: "modified" },
      ],
    }),
  }),
  resultStory(
    "publish",
    "release",
    result("publish", {
      release: {
        release_id: "release-1",
        version: "1.2.0",
        revision_id: "skit-7",
        archive_digest: hash,
        download_path: "/api/skits/smol-ai/review-tools/releases/1.2.0",
      },
    }),
  ),
  resultStory(
    "author-watch",
    "watching",
    result("authorWatch", { event: "watching", path: "/home/story/work/review-tools" }),
  ),
  resultStory(
    "author-watch",
    "saved-locally",
    result("authorWatch", {
      event: "saved_locally",
      revision_id: "revision-story",
      trigger: "filesystem",
      paths: ["skills/review/SKILL.md"],
    }),
  ),
  resultStory(
    "author-watch",
    "unregistered",
    result("authorWatch", {
      event: "installation",
      path: "/home/story/work/review-tools",
      reason: "configuration-changed",
      status: "unregistered",
      installed: 0,
      installed_copies: [],
      issues: [],
    }),
  ),
  resultStory(
    "author-watch",
    "retrying",
    result("authorWatch", {
      event: "retrying",
      operation: "sync",
      failure: new LocalFilesChangedDuringSync(),
    }),
  ),
  OutputStory.Result({
    group: "author-watch",
    name: "credential-scope-missing",
    result: result("authorWatch", {
      event: "retrying",
      operation: "sync",
      failure: new CredentialLacksScope({
        scope: "authoring:write",
        origin: "https://registry.example.com",
      }),
    }),
  }),
  resultStory(
    "author-watch",
    "recovered",
    result("authorWatch", { event: "recovered", operation: "sync" }),
  ),
  resultStory(
    "sync",
    "created",
    result("sync", {
      status: "created",
      changed: true,
      identity: {
        authority: "registry.example",
        namespace: "smol-ai",
        skit: "review-tools",
        locator: "skit://registry.example/smol-ai/review-tools",
      },
      visibility: "private",
      revision_id: `sha256:${"a".repeat(64)}`,
      paths: ["skit.json", "skills/review/SKILL.md"],
      remote_home_recorded: true,
      published: false,
    }),
  ),
  ...(["push", "pull", "merge"] as const).map((action) =>
    resultStory(
      "sync",
      action === "push" ? "ready" : `ready-${action}`,
      result("sync", { status: "ready", changed: false, action }),
    ),
  ),
  resultStory(
    "sync",
    "up-to-date",
    result("sync", {
      status: "up_to_date",
      changed: false,
      revision_id: `sha256:${"a".repeat(64)}`,
    }),
  ),
  resultStory(
    "sync",
    "pulled",
    result("sync", {
      status: "pulled",
      changed: true,
      revision_id: `sha256:${"a".repeat(64)}`,
      paths: ["skills/review/SKILL.md"],
    }),
  ),
  resultStory(
    "sync",
    "pushed",
    result("sync", { status: "pushed", changed: true, revision_id: `sha256:${"a".repeat(64)}` }),
  ),
  ...(["blocked", "waiting_for_removal"] as const).map((status) =>
    resultStory(
      "sync",
      status.replaceAll("_", "-"),
      result("sync", {
        status,
        changed: false,
        deleting: status === "blocked" ? 8 : 1,
        of: status === "blocked" ? 14 : 3,
        paths:
          status === "blocked"
            ? Array.from({ length: 8 }, (_, index) => `notes/${index}.txt`)
            : ["notes/checklist.md"],
      }),
    ),
  ),
  resultStory(
    "author-watch",
    "sync-pushed",
    result("authorWatch", {
      event: "sync",
      result: { status: "pushed", changed: true, revision_id: `sha256:${"a".repeat(64)}` },
    }),
  ),
  resultStory(
    "sync",
    "first-sync-ready",
    result("sync", {
      status: "first_sync_ready",
      changed: false,
      identity: {
        authority: "registry.example",
        namespace: "smol-ai",
        skit: "review-tools",
        locator: "skit://registry.example/smol-ai/review-tools",
      },
      visibility: "private",
      file_count: 3,
      effects: ["create_skit", "save_revision", "record_remote_home"],
    }),
  ),
  resultStory(
    "sync",
    "merged",
    result("sync", {
      status: "merged",
      changed: true,
      revision_id: `sha256:${"a".repeat(64)}`,
      paths: ["skills/review/SKILL.md"],
      choices: [{ path: "skills/review/SKILL.md", kind: "both_modified", kept: "remote" }],
    }),
  ),
  resultStory(
    "library-sync",
    "push-ready",
    result("librarySync", {
      status: "push_ready",
      plan: {
        local: [],
        remote: [
          {
            kind: "collection",
            action: "add",
            subject_id: syncCollections.swyxio,
            label: "swyxio/skills",
            skills_added: ["cli-ux", "skill-cutter"],
            skills_changed: [],
            skills_removed: [],
            evidence_only: false,
          },
        ],
      },
    }),
  ),
  ...(["pushed", "pulled"] as const).map((status) =>
    resultStory(
      "library-sync",
      status,
      result("librarySync", { status, changed: true, revision_id: "revision-story" }),
    ),
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
    "library-sync",
    "merge-ready",
    result("librarySync", {
      status: "merge_ready",
      merge_base: "empty-first-sync",
      plan: {
        enabled_resolution: {
          winner: "local",
          collections: [{ collection_id: syncCollections.swyxio, label: "swyxio/skills" }],
        },
        local: [
          {
            kind: "collection",
            action: "update",
            subject_id: syncCollections.swyxio,
            label: "swyxio/skills",
            skills_added: ["cli-ux"],
            skills_changed: ["autoreview", "cloudflare"],
            skills_removed: [
              "accelevents-api",
              "accelevents-speaker-sync",
              "agents-sdk",
              "ai-devblog",
              "ai-engineering",
              "ai-readme",
            ],
            evidence_only: false,
          },
          {
            kind: "collection",
            action: "update",
            subject_id: syncCollections.nvidia,
            label: "NVIDIA/skills",
            skills_added: [],
            skills_changed: [],
            skills_removed: [],
            evidence_only: true,
          },
        ],
        remote: [
          {
            kind: "collection",
            action: "add",
            subject_id: syncCollections.asmartbear,
            label: "asmartbear/asb-skills",
            skills_added: [
              "asb-carol-dealbreakers",
              "asb-carol-define",
              "asb-carol-inciting-events",
              "asb-carol-keystones",
              "asb-carol-observations",
              "asb-carol-strengths",
              "asb-interview-debrief",
              "asb-interview-goals",
              "asb-interview-hypotheses",
              "asb-interview-learning",
              "asb-interview-questions",
              "asb-interview-report",
              "asb-more-or-less",
              "asb-needs-stack",
              "asb-positioning",
              "asb-problem",
              "asb-raise-prices",
              "asb-rude-qa",
              "asb-voters",
              "asb-who-me",
              "asb-willingness-to-pay",
              "book-prose-writer",
              "create-asb-skill",
              "doc-skills",
              "exercise-asb-skill",
              "jason-corpus-search",
            ],
            skills_changed: [],
            skills_removed: [],
            evidence_only: false,
          },
          {
            kind: "enabled",
            action: "update",
            items_added: [{ kind: "skill", label: "cli-ux" }],
            items_removed: [{ kind: "collection", label: "NVIDIA/skills" }],
          },
        ],
      },
    }),
  ),
  resultStory(
    "library-sync",
    "pull-ready-no-changes",
    result("librarySync", { status: "pull_ready", plan: { local: [], remote: [] } }),
  ),
  resultStory("library-sync", "clean", result("librarySync", { status: "clean" })),
  resultStory(
    "library-sync",
    "conflicted",
    result("librarySync", {
      status: "conflicted",
      conflicts: [`collection:${syncCollections.swyxio}`, `skill:${skillId}`],
    }),
  ),
  resultStory(
    "library-sync",
    "conflicted-details",
    result("librarySync", {
      status: "conflicted",
      merge_base: "empty-different-library",
      conflict_details: [
        {
          _tag: "CollectionChanged",
          key: `collection:${syncCollections.swyxio}`,
          resolution: "take-remote",
          label: "swyxio/skills",
        },
        {
          _tag: "DestinationCollision",
          key: "projection:/home/story/.agents/skills/nvidia-skill-finder:collision",
          resolution: "keep-enabled",
          skills: [
            { id: skillId, name: "nvidia-skill-finder", collection: "NVIDIA/skills" },
            { id: pluginSkillId, name: "nvidia-skill-finder", collection: "NVIDIA/skills" },
          ],
        },
      ],
    }),
  ),
  resultStory(
    "library-sync",
    "manifest-overlapping-paths",
    result("librarySync", {
      status: "conflicted",
      conflict_details: [
        {
          _tag: "LibraryInvalid",
          key: "manifest:invariants",
          resolution: "local",
          failure: overlappingMergedSkills(),
        },
      ],
    }),
  ),
  resultStory(
    "library-sync",
    "resolution-invalid",
    result("librarySync", { status: "resolution_invalid" }),
  ),
  resultStory(
    "library-sync",
    "enablement-incomplete",
    result("librarySync", {
      status: "enablement_incomplete",
      enablement_issues: [
        {
          _tag: "ExistingCopy",
          copy: {
            name: "cli-ux",
            harness: "claude-code",
            canonicalPath: "/home/story/.claude/skills/cli-ux",
            aliases: [{ path: "/home/story/.claude/skills/cli-ux", via: "directory" }],
            documentHash: hash,
          },
        },
      ],
    }),
  ),
  resultStory(
    "library-sync",
    "local-bytes-changed",
    result("librarySync", { status: "local_bytes_changed" }),
  ),
  ...(
    [
      {
        name: "device-selection-missing",
        scenario: {
          initial:
            "This device selects one Skill independently of the account's enabled list. Another device removes that Skill from the Library.",
          trigger: "Apply Library sync on this device.",
          result:
            "The Library syncs. The device's selection stays recorded, and SKIT identifies the missing Skill instead of silently dropping the choice.",
        },
        issue: { _tag: "SelectionMissing", selection: { skill: skillId } },
      },
      {
        name: "device-duplicate-scan-unreadable",
        scenario: {
          initial:
            "This device has its own Skill selection. The filesystem refuses access to a skills directory that could contain another copy.",
          trigger: "Apply Library sync and check the device's selected Skills.",
          result:
            "The Library syncs, but SKIT leaves device enablement incomplete and identifies the unreadable directory.",
        },
        issue: {
          _tag: "DuplicateScanFailed",
          failure: systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readDirectory",
            pathOrDescriptor: `${storyHome}/.codex/skills`,
          }),
        },
      },
      {
        name: "device-installation-failed",
        scenario: {
          initial:
            "The remote Library has synced and this device has selected a Skill to enable. The filesystem refuses the installer's staging directory.",
          trigger: "Install the selected Skill after syncing the Library.",
          result:
            "SKIT reports the filesystem failure and keeps the device selection so a later sync can retry.",
        },
        issue: {
          _tag: "InstallationFailed",
          failure: systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "makeTempDirectoryScoped",
            pathOrDescriptor: `${storyHome}/.agents`,
          }),
        },
      },
      {
        name: "device-folder-conflicted",
        scenario: {
          initial:
            "The folder for a selected Skill has no SKIT ownership marker, and its files differ from the Library's recorded content.",
          trigger: "Install the device's selected Skills after syncing the Library.",
          result: "SKIT leaves the folder in place and reports both failed checks precisely.",
        },
        issue: {
          _tag: "InstalledFolderConflicted",
          path: `${storyHome}/.agents/skills/review`,
          conflicts: [
            { _tag: "MarkerMissing" },
            {
              _tag: "ContentChanged",
              expected: hash,
              actual: `sha256:${"1".repeat(64)}`,
              baseline: "library",
            },
          ],
        },
      },
    ] as const
  ).map(({ name, scenario, issue }) =>
    OutputStory.Result({
      group: "library-sync",
      name,
      scenario,
      result: result("librarySync", {
        status: "enablement_incomplete",
        enablement_issues: [issue],
      }),
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
      scopes: ["library:sync", "authoring:write", "publication:write"],
      expiresAt: "2027-01-01T00:00:00Z",
    }),
  ),
  resultStory(
    "auth-login",
    "previous-credential-not-revoked",
    result("authLogin", {
      origin: "https://registry.example",
      tokenPrefix: "skit_pat_new",
      scopes: ["library:sync", "authoring:write"],
      warning: {
        _tag: "PreviousCredentialNotRevoked",
        tokenId: "previous-credential",
        tokenPrefix: "skit_pat_old",
        cleanup: { _tag: "ResponseRejected", status: 503 },
      },
    }),
  ),
  resultStory(
    "auth-login",
    "previous-credential-cleanup-response-lost",
    result("authLogin", {
      origin: "https://registry.example",
      tokenPrefix: "skit_pat_new",
      scopes: ["library:sync"],
      warning: {
        _tag: "PreviousCredentialNotRevoked",
        tokenId: "previous-credential",
        tokenPrefix: "skit_pat_old",
        cleanup: {
          _tag: "RequestFailed",
          failure: new RegistryTransportError({
            cause: new Error(
              "The Registry closed the connection before its revocation response arrived",
            ),
          }),
        },
      },
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
    "feedback-send",
    "sent",
    result("feedbackSend", {
      id: "feedback_0123456789abcdef0123456789abcdef",
      createdAt: "2026-10-29T09:00:00.000Z",
      recipient: "https://skit.smol.ai",
      signedIn: false,
    }),
  ),
  resultStory(
    "feedback-send",
    "signed",
    result("feedbackSend", {
      id: "feedback_0123456789abcdef0123456789abcdef",
      createdAt: "2026-10-29T09:00:00.000Z",
      recipient: "https://skit.smol.ai",
      signedIn: true,
      email: "ada@example.com",
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
          failure: null,
        },
      ],
    }),
  ),
  resultStory(
    "harness-probe",
    "timeout",
    result("experimentalHarnessProbe", {
      probes: [
        {
          harnessId: "codex",
          status: "failed",
          command: "codex",
          executablePath: "/home/story/bin/codex",
          resolvedPath: "/home/story/bin/codex",
          version: null,
          versionOutput: null,
          failure: {
            _tag: "ProcessFailed",
            failure: new SourceProcessTimedOut({
              invocation: "/home/story/bin/codex --version",
              timeoutMs: 5000,
            }),
          },
        },
      ],
    }),
  ),
  resultStory(
    "harness-probe",
    "missing",
    result("experimentalHarnessProbe", {
      probes: [
        {
          harnessId: "codex",
          status: "missing",
          command: "codex",
          executablePath: null,
          resolvedPath: null,
          version: null,
          versionOutput: null,
          failure: { _tag: "ExecutableMissing", command: "codex" },
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
      roots: { home: "/home/story", cwd: "/home/story/work/review-tools" },
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
      generatedAt: "2026-09-30T20:00:00Z",
      roots: { home: "/home/story", cwd: "/home/story/work/review-tools" },
      harnesses: [
        {
          id: "claude-code",
          detected: true,
          profileId: "claude-code",
          profileVersion: "1",
          frontmatterContracts: [],
          skillMetadataContracts: [],
          documentation: [],
          entryIds: ["rule:delegate"],
        },
      ],
      skills: [],
      plugins: [],
      mcpServers: [],
      rules: [
        {
          id: "rule:delegate",
          name: "delegate.md",
          harnessIds: ["claude-code"],
          scope: "user",
          location: "/home/story/.claude/rules/delegate.md",
          provenance: {
            confidence: "unknown",
            origin: { _tag: "Unknown" },
            evidence: "/home/story/.claude/rules/delegate.md",
          },
        },
      ],
      marketplaces: [],
      findings: [
        {
          id: "finding:missing-mcp",
          severity: "warning",
          code: "advertised-mcp-not-configured",
          entryIds: [],
          unresolvedSubject: "reviewer",
          reason: { _tag: "McpRegistrationMissing", server: "reviewer" },
          locations: ["/home/story/.claude/rules/delegate.md"],
          details: {
            server: "reviewer",
            advertisingPaths: ["/home/story/.claude/rules/delegate.md"],
          },
        },
      ],
      probes: [],
      coverage: { deferredHarnessIds: [] },
      summary: {
        harnesses: 1,
        skills: 0,
        plugins: 0,
        mcpServers: 0,
        rules: 1,
        marketplaces: 0,
        findings: 1,
      },
    }),
  ),
  resultStory(
    "audit",
    "codex-config-unsupported-syntax",
    result("experimentalAuditV1Alpha4", {
      schemaVersion: "v1alpha4",
      generatedAt: "2026-09-30T20:00:00Z",
      roots: { home: "/home/story", cwd: "/home/story/work/review-tools" },
      harnesses: [],
      skills: [],
      plugins: [],
      mcpServers: [],
      rules: [],
      marketplaces: [],
      findings: [
        {
          id: "finding:codex-config",
          severity: "warning",
          code: "codex-config-parse-failed",
          entryIds: [],
          unresolvedSubject: "/home/story/.codex/config.toml",
          reason: {
            _tag: "CodexConfigurationInvalid",
            scope: "user",
            issue: { _tag: "UnsupportedLine", line: 3 },
          },
          locations: ["/home/story/.codex/config.toml"],
          details: { configPath: "/home/story/.codex/config.toml" },
        },
      ],
      probes: [],
      coverage: { deferredHarnessIds: [] },
      summary: {
        harnesses: 0,
        skills: 0,
        plugins: 0,
        mcpServers: 0,
        rules: 0,
        marketplaces: 0,
        findings: 1,
      },
    }),
  ),
  ...SetupImportInvalid.fields.reason.literals.map((reason) =>
    failureStory(
      `setup-import-${reason}`,
      classifyFailure(new SetupImportInvalid({ skillName: "review", reason })),
    ),
  ),
  ...(["ManageTargetChanged", "ManageContentMismatch"] as const).map((_tag) =>
    failureStory(
      `manage-${_tag}`,
      classifyFailure(
        new InstalledSkillInvalid({ reason: { _tag, path: `${storyHome}/.agents/skills/review` } }),
      ),
    ),
  ),
  failureStory(
    "options-conflict",
    classifyFailure(
      new OptionCombinationInvalid({
        reason: {
          _tag: "OptionConflicts",
          option: "--follow-account",
          others: ["--device-skill", "--device-collection"],
        },
      }),
    ),
  ),
  failureStory(
    "setup-plan-id-invalid",
    classifyFailure(
      new OptionCombinationInvalid({
        reason: { _tag: "SetupPlanIdInvalid", option: "--compare", value: "short" },
      }),
    ),
  ),
  failureStory(
    "nothing-enabled-in-repository",
    classifyFailure(
      new NothingToSelect({
        reason: {
          _tag: "EnabledSkills",
          scope: { kind: "repository", root: `${storyHome}/work/review tools` },
        },
      }),
    ),
  ),
  failureStory(
    "command-line-invalid",
    classifyFailure(
      new CommandLineInvalid({ errors: [new CliError.MissingArgument({ argument: "path" })] }),
    ),
  ),
  failureStory(
    "library-response-invalid",
    classifyFailure(
      new LibraryApiInvalidResponse({
        operation: "read portable Library",
        failure: {
          _tag: "StoredSchemaFailure",
          issues: [{ path: ["library", "manifest"], reason: { _tag: "MissingKey" } }],
        },
      }),
    ),
  ),
  failureStory(
    "help-document-missing",
    classifyFailure(new HelpDocumentMissing({ command: "security review" })),
  ),
  failureStory(
    "release-check-timed-out",
    classifyFailure(
      new UpdateCheckTimedOut({
        source: "https://registry.npmjs.org/-/package/@smolai/skit/dist-tags",
        timeoutMs: 1_500,
      }),
    ),
  ),
  failureStory(
    "finding-fingerprint-invalid",
    classifyFailure(new FindingFingerprintInvalid({ value: "sha256:short" })),
  ),
  failureStory(
    "bootstrap-cleanup-unconfirmed",
    classifyFailure(
      new BootstrapCleanupFailed({
        target: {
          configPath: "/home/story/work/team server/wrangler.jsonc",
          environment: "preview",
        },
        command: "wrangler",
        original: new BootstrapExternalFailure({
          operation: "install-secret",
          reason: {
            _tag: "ProcessFailed",
            command: "wrangler",
            exitCode: 1,
            output: "Connection closed before Wrangler confirmed installation.",
          },
        }),
        cleanup: new BootstrapExternalFailure({
          operation: "remove-secret",
          reason: {
            _tag: "ProcessFailed",
            command: "wrangler",
            exitCode: 1,
            output: "Cloudflare is unavailable.\nSecret deletion could not be confirmed.",
          },
        }),
      }),
    ),
  ),
  failureStory(
    "bootstrap-environment-required",
    classifyFailure(
      new BootstrapConfigInvalid({
        target: { configPath: "/home/story/work/team server/wrangler.jsonc" },
        reason: { _tag: "EnvironmentRequired", environments: ["preview", "production"] },
      }),
    ),
  ),
  failureStory(
    "auth-credential-creation-unconfirmed",
    classifyFailure(
      new SignInFailed({
        origin: "https://registry.example",
        reason: {
          _tag: "ResponseInvalid",
          operation: "credential-create",
          failure: new Error("The Registry closed the response before it could be read"),
        },
      }),
    ),
  ),
  failureStory(
    "auth-session-cleanup-failed",
    classifyFailure(
      new SignInFailed({
        origin: "https://registry.example",
        reason: {
          _tag: "SessionEndFailed",
          cleanup: { _tag: "ResponseRejected", status: 503 },
          original: new SignInRejected({ operation: "credential-create" }),
        },
      }),
    ),
  ),
  failureStory(
    "auth-cleanup-responses-lost",
    classifyFailure(
      new SignInFailed({
        origin: "https://registry.example",
        reason: {
          _tag: "SessionEndFailed",
          cleanup: {
            _tag: "RequestFailed",
            failure: new RegistryTransportError({
              cause: new Error("The session sign-out response never arrived"),
            }),
          },
          credential: {
            tokenId: "unsaved-credential",
            tokenPrefix: "skit_pat_new",
            cleanup: {
              _tag: "RequestFailed",
              failure: new RegistryTransportError({
                cause: new Error("The credential revocation response never arrived"),
              }),
            },
          },
        },
      }),
    ),
  ),
  failureStory(
    "auth-storage-and-cleanup-response-lost",
    classifyFailure(
      new SignInFailed({
        origin: "https://registry.example",
        reason: {
          _tag: "StorageCleanupFailed",
          tokenId: "unsaved-credential",
          tokenPrefix: "skit_pat_new",
          cleanup: {
            _tag: "RequestFailed",
            failure: new RegistryTransportError({
              cause: new Error("The credential revocation response never arrived"),
            }),
          },
          original: systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: "/home/story/.skit/auth.json",
          }),
        },
      }),
    ),
  ),
  failureStory(
    "auth-storage-cleanup-failed",
    classifyFailure(
      new SignInFailed({
        origin: "https://registry.example",
        reason: {
          _tag: "StorageCleanupFailed",
          tokenId: "unsaved-credential",
          tokenPrefix: "skit_pat_abc",
          cleanup: { _tag: "ResponseRejected", status: 503 },
          original: systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: "/home/story/.skit/auth.json",
          }),
        },
      }),
    ),
  ),
  failureStory(
    "auth-logout-rejected",
    classifyFailure(
      new SignOutRejected({
        origin: "https://registry.example",
        reason: {
          _tag: "ResponseRejected",
          status: 503,
          registryCode: "storage_failure",
        },
      }),
    ),
  ),
  failureStory(
    "registry-author-request-timeout",
    classifyFailure(
      new AuthorRequestTimedOut({
        origin: "https://registry.example.com",
        operation: "move",
        timeoutMs: 30_000,
      }),
    ),
  ),
  failureStory(
    "publication-unconfirmed",
    classifyFailure(
      new PublicationResponseError({
        reason: {
          _tag: "ResponseFailure",
          origin: "https://registry.example.com",
          status: 502,
          body: "upstream unavailable\nThe proxy could not confirm the Registry response.",
          failure: new Error("HTTP 502"),
        },
      }),
    ),
  ),
  failureStory(
    "publication-destination-invalid",
    classifyFailure(
      new PublicationResponseError({
        reason: {
          _tag: "DestinationInvalid",
          origin: "https://registry.example.com",
          issues: ["credentials", "fragment"],
        },
      }),
    ),
  ),
  failureStory(
    "registry-request-rejected",
    classifyFailure(new LibraryApiRejected({ status: 502 })),
  ),
  failureStory(
    "registry-body-read-failed",
    classifyFailure(
      registryContractFailure(
        "publish response",
        new Error("The Registry response body could not be read", {
          cause: new Error("connection reset"),
        }),
      ),
    ),
  ),
  failureStory(
    "registry-selection-required",
    classifyFailure(
      new RegistrySelectionAmbiguous({
        origins: ["https://registry.example.com", "https://team.example.com"],
        command: "skit auth logout <origin-or-alias>",
      }),
    ),
  ),
  failureStory(
    "credential-scope-missing",
    classifyFailure(
      new CredentialLacksScope({
        scope: "authoring:write",
        origin: "https://registry.example.com",
      }),
    ),
  ),
  failureStory(
    "credential-file-unreadable",
    classifyFailure(
      new CredentialsUnusable({ path: `${storyHome}/.skit/auth.json`, reason: "unreadable" }),
    ),
  ),
  failureStory(
    "author-sync-required",
    classifyFailure(new AuthorSyncRequired({ root: `${storyHome}/work/review tools` })),
  ),
  failureStory(
    "required-input-missing",
    classifyFailure(new MissingRequirement({ reason: { _tag: "PublishVersion" } })),
  ),
  failureStory(
    "prompt-cancelled",
    classifyFailure(new PromptCancelled({ prompt: "Choose Skills", reason: "back" })),
  ),
  failureStory(
    "recorded-schema-failure",
    classifyFailure(
      new StepSchemaFailure({
        failure: {
          _tag: "StoredSchemaFailure",
          issues: [
            { path: ["enabled"], reason: { _tag: "InvalidType", expected: [{ type: "Boolean" }] } },
          ],
        },
      }),
    ),
  ),
  failureStory(
    "update-selection-not-recorded",
    classifyFailure(
      new SetupStopped({
        operationId: makeOperationId(),
        reason: { _tag: "StepFailed", step: 0, error: new UpdateSelectionMissing() },
      }),
    ),
  ),
  failureStory("library-enabled-subject-missing", classifyFailure(missingEnabledSubject())),
  failureStory("library-collection-id-invalid", classifyFailure(invalidCollectionIdentifier())),
  failureStory("native-schema-issue", classifyFailure(rawSchemaIssue())),
  resultStory(
    "list",
    "workspace-location-unavailable",
    result("list", {
      subjects: [
        {
          subject_id: collectionId,
          subject_kind: "collection",
          label: "review-tools",
          collection_source: {
            kind: "authored-workspace",
            name: "review-tools",
            locator: "",
            workspace_status: "unavailable",
          },
          skills: [
            {
              name: "review",
              skill_id: skillId,
              versions: [],
              source: null,
              revision: null,
              source_updated_at: null,
              imported_at: null,
            },
          ],
        },
      ],
      enabled: [],
      enabled_skills: [],
    }),
  ),
  failureStory(
    "internal-archive-stream-invalid",
    classifyFailure(new ArchiveStreamInvalid({ path: `${storyHome}/work/review-tools.zip` })),
  ),
  failureStory(
    "tree-normalized-path-collision",
    classifyFailure(
      new TreeError({
        reason: {
          _tag: "NormalizedPathCollision",
          path: "caf\u00e9.md",
          firstPath: "caf\u00e9.md",
          secondPath: "cafe\u0301.md",
        },
      }),
    ),
  ),
  failureStory(
    "tree-identity-missing",
    classifyFailure(
      new TreeError({
        reason: {
          _tag: "NativeIdentityMissing",
          entryType: "Directory",
          path: `${storyHome}/work/review-tools`,
        },
      }),
    ),
  ),
  failureStory(
    "tree-root-symlink",
    classifyFailure(
      new TreeError({
        reason: {
          _tag: "RootNotDirectory",
          entryType: "SymbolicLink",
          path: `${storyHome}/work/review-tools`,
        },
      }),
    ),
  ),
  failureStory(
    "publication-blocked",
    classifyFailure(
      new PublicationBlocked({
        reason: "content",
        diagnostics: [{ code: "SKILL_FILE_MISSING", severity: "error", path: "review/SKILL.md" }],
      }),
    ),
  ),
  failureStory(
    "archive-validation",
    classifyFailure(
      new SkitValidationFailed({
        diagnostics: [
          {
            code: "INVOCATION_METADATA_MISMATCH",
            severity: "error",
            path: "skills/review/agents/openai.yaml",
            issue: {
              skill: "review",
              harness: "codex",
              path: "skills/review/agents/openai.yaml",
              field: "allow_implicit_invocation",
              policy: "explicit",
              expected: "explicit",
              actual: "implicit",
            },
          },
        ],
      }),
    ),
  ),
  failureStory(
    "source-command-output",
    classifyFailure(
      new CommandFailed({
        command: "git fetch",
        exitCode: 128,
        stderr:
          "fatal: the requested revision is not available\ncheck the source pin and remote history",
      }),
    ),
  ),
  failureStory(
    "source-version-unavailable",
    classifyFailure(
      new SourceRestoreInvalid({
        hash,
        reason: {
          _tag: "SourceFetchFailed",
          failure: new SourcePolicyViolation({
            reason: {
              _tag: "GitRevisionUnavailable",
              revision: "1234567890abcdef",
              remote: "https://git.example.com/review-tools",
              failure: new CommandFailed({
                command: "git fetch origin 1234567890abcdef",
                exitCode: 128,
                stderr:
                  "fatal: the requested revision is not available\ncheck the source pin and remote history",
              }),
            },
          }),
        },
      }),
    ),
  ),
  failureStory(
    "recovery-step-failed",
    classifyFailure(
      new RecoveryInvalid({
        reason: {
          _tag: "OperationStopped",
          operation: "Undo",
          operationId: makeOperationId(),
          reason: {
            _tag: "StepFailed",
            step: 1,
            error: new UninstallConflict({ path: `${storyHome}/.agents/skills/review` }),
          },
        },
      }),
    ),
  ),
  failureStory(
    "additional-failures",
    commandFailure(
      Cause.combine(
        Cause.fail(new ContentAddressCollision()),
        Cause.fail(new LibraryChanged({ path: `${storyHome}/.skit/state.json` })),
      ),
    ),
  ),
  failureStory(
    "not-found",
    classifyFailure(new LibrarySubjectNotFound({ query: "owner/missing" })),
  ),
  failureStory(
    "installed-skill-conflict",
    classifyFailure(new UninstallConflict({ path: `${storyHome}/.agents/skills/review` })),
  ),
];

export const outputStoryKey = (story: OutputStory): string => `${story.group}/${story.name}`;
