import { DuplicateCopy } from "../../projection/duplicates.js";
import {
  CollectionId,
  Digest,
  HarnessName,
  MachineId,
  InstalledSkillId,
  SkillId,
  SkillVersionId,
} from "@smolai/skit-core";
import { Schema } from "effect";
import { PnpmSkillOwner } from "../../projection/pnpm-skills.js";

export const SetupVersionChoice = Schema.Struct({
  skillId: SkillId,
  version: Schema.Literals(["retained", "local"]),
  path: Schema.optionalKey(Schema.String),
});
export type SetupVersionChoice = typeof SetupVersionChoice.Type;

export const SetupProbe = Schema.Struct({
  harness: HarnessName,
  status: Schema.Literals(["installed", "missing", "failed"]),
  command: Schema.String,
});
export type SetupProbe = typeof SetupProbe.Type;

export const SetupGitStatus = Schema.Struct({
  status: Schema.Literals([
    "committed",
    "modified",
    "staged",
    "untracked",
    "ignored",
    "mixed",
    "outside-git",
    "unavailable",
  ]),
  repository: Schema.optionalKey(Schema.String),
});
export type SetupGitStatus = typeof SetupGitStatus.Type;

export const SetupSkillsLockEntry = Schema.Struct({
  name: Schema.String,
  source: Schema.String,
  sourceType: Schema.String,
  sourceUrl: Schema.optionalKey(Schema.String),
  sourceBaseUrl: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
  skillPath: Schema.optionalKey(Schema.String),
  computedHash: Schema.optionalKey(Schema.String),
  skillFolderHash: Schema.optionalKey(Schema.String),
  wellKnownDigest: Schema.optionalKey(Schema.String),
  originalEntry: Schema.JsonObject,
});
export type SetupSkillsLockEntry = typeof SetupSkillsLockEntry.Type;

export const SetupSkillsLock = Schema.Struct({
  scope: Schema.Literals(["project", "global"]),
  path: Schema.String,
  status: Schema.Literals(["valid", "malformed", "unsupported"]),
  version: Schema.optionalKey(Schema.Number),
  contentHash: Schema.optionalKey(Digest),
  entries: Schema.Array(SetupSkillsLockEntry),
});
export type SetupSkillsLock = typeof SetupSkillsLock.Type;

export const SetupLockMatch = Schema.Struct({
  scope: Schema.Literals(["project", "global"]),
  lockPath: Schema.String,
  lockVersion: Schema.Number,
  lockContentHash: Digest,
  content: Schema.Literals(["agrees", "mismatch", "unverifiable"]),
  entry: SetupSkillsLockEntry,
});
export type SetupLockMatch = typeof SetupLockMatch.Type;

export const SetupContentIdentity = Schema.Struct({
  status: Schema.Literals(["exact", "ambiguous", "none", "unhashable"]),
  observedHash: Schema.optionalKey(Digest),
  libraryMatches: Schema.Array(
    Schema.Struct({
      subjectId: Schema.String,
      skillId: SkillId,
      skillVersionId: SkillVersionId,
      name: Schema.String,
    }),
  ),
});
export type SetupContentIdentity = typeof SetupContentIdentity.Type;

export const SetupManagedMembership = Schema.Union([
  Schema.Struct({
    kind: Schema.tag("retained"),
    projectionId: InstalledSkillId,
    collectionId: Schema.optionalKey(CollectionId),
    skillId: SkillId,
    skillVersionId: SkillVersionId,
    displayName: Schema.String,
    source: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.tag("missing-from-library"),
    projectionId: InstalledSkillId,
    collectionId: Schema.optionalKey(CollectionId),
    skillId: SkillId,
    skillVersionId: SkillVersionId,
  }),
]);
export type SetupManagedMembership = typeof SetupManagedMembership.Type;

export const SetupInstanceOwner = Schema.Union([
  PnpmSkillOwner,
  Schema.Struct({ kind: Schema.tag("skit"), membership: SetupManagedMembership }),
  Schema.Struct({ kind: Schema.tag("invalid-marker") }),
  Schema.Struct({
    kind: Schema.tag("authored"),
    skitLocator: Schema.String,
    collectionId: Schema.optionalKey(CollectionId),
  }),
  Schema.Struct({ kind: Schema.tag("skills-sh"), source: Schema.String }),
  Schema.Struct({
    kind: Schema.tag("harness"),
    harness: HarnessName,
    source: Schema.String,
    bundled: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.tag("repository"), repository: Schema.String }),
  Schema.Struct({ kind: Schema.tag("unknown") }),
]);
export type SetupInstanceOwner = typeof SetupInstanceOwner.Type;

export const SetupSkillInstance = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  aliases: Schema.Array(Schema.String),
  scope: Schema.Literals(["global", "project", "standalone"]),
  harnesses: Schema.Array(HarnessName),
  owner: SetupInstanceOwner,
  contentIdentity: SetupContentIdentity,
  git: SetupGitStatus,
  locks: Schema.Array(SetupLockMatch),
});
export type SetupSkillInstance = typeof SetupSkillInstance.Type;

export const SetupBrokenLink = Schema.Struct({
  path: Schema.String,
  target: Schema.String,
  harnesses: Schema.Array(HarnessName),
});
export type SetupBrokenLink = typeof SetupBrokenLink.Type;

export const SetupSuppressed = Schema.Struct({
  path: Schema.String,
  reason: Schema.Literals(["cache", "dependency", "generated", "build", "skit-state"]),
});
export type SetupSuppressed = typeof SetupSuppressed.Type;

export const SetupRepository = Schema.Struct({
  path: Schema.String,
  skills: Schema.Array(Schema.String),
  status: Schema.Literals(["watched", "ignored", "undecided"]),
});
export type SetupRepository = typeof SetupRepository.Type;

export const RepositoryPolicyResult = Schema.Struct({
  action: Schema.Literals(["list", "watch", "ignore", "forget"]),
  path: Schema.String,
  repositories: Schema.Array(
    Schema.Struct({ path: Schema.String, status: Schema.Literals(["watched", "ignored"]) }),
  ),
});

export const SetupRepositoryConfig = Schema.Struct({
  repository: Schema.String,
  path: Schema.String,
  status: Schema.Literals(["missing", "valid", "malformed", "unsupported"]),
  schema: Schema.optionalKey(Schema.String),
  exclude: Schema.Array(Schema.String),
  collections: Schema.Array(Schema.Struct({ path: Schema.String })),
});
export type SetupRepositoryConfig = typeof SetupRepositoryConfig.Type;

export const SetupAuthoredCollection = Schema.Struct({
  repository: Schema.String,
  descriptorPath: Schema.String,
  remotePath: Schema.String,
  skitLocator: Schema.String,
  origin: Schema.String,
  namespace: Schema.String,
  skit: Schema.String,
  collectionId: Schema.optionalKey(CollectionId),
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
    }),
  ),
});
export type SetupAuthoredCollection = typeof SetupAuthoredCollection.Type;

export const SetupInstalledSkill = Schema.Struct({
  collectionId: Schema.optionalKey(CollectionId),
  collectionDisplayName: Schema.String,
  skillId: SkillId,
  name: Schema.String,
  path: Schema.optionalKey(Schema.String),
  harnesses: Schema.Array(HarnessName),
  status: Schema.Literals(["current", "modified", "missing"]),
});
export type SetupInstalledSkill = typeof SetupInstalledSkill.Type;

export const SetupReconciliationFact = Schema.Struct({
  projectionId: InstalledSkillId,
  skillId: SkillId,
  name: Schema.String,
  path: Schema.String,
  target: Schema.Literals(["agents", "claude"]),
  baselineHash: Digest,
  currentHash: Schema.optionalKey(Digest),
  desiredHash: Schema.optionalKey(Digest),
  desiredVersionId: Schema.optionalKey(SkillVersionId),
  evidence: Digest,
  status: Schema.Literals([
    "unchanged",
    "incoming-update",
    "local-only",
    "competing",
    "protected",
    "native-delete",
  ]),
  metadataChanged: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
});
export type SetupReconciliationFact = typeof SetupReconciliationFact.Type;
export const SetupReconciliationOutcome = Schema.Struct({
  reason: Schema.optionalKey(Schema.String),
  projectionId: InstalledSkillId,
  name: Schema.String,
  path: Schema.String,
  status: Schema.Literals(["updated", "unchanged", "local-kept", "native-delete", "pending"]),
});
export type SetupReconciliationOutcome = typeof SetupReconciliationOutcome.Type;

const SetupOnboardingBase = {
  shadows: Schema.optionalKey(Schema.Array(DuplicateCopy)),
  /** Links at SKIT's own destinations that enabling this skill would replace with copies. */
  destinationLinks: Schema.optionalKey(Schema.Array(Schema.String)),
  name: Schema.String,
  paths: Schema.Array(Schema.String),
  owner: SetupInstanceOwner,
} as const;

export const SetupOnboardingCandidate = Schema.Union([
  Schema.Struct({
    ...SetupOnboardingBase,
    action: Schema.tag("import-observed-collection"),
    groupKey: Schema.String,
    source: Schema.String,
    lockContentHash: Digest,
    contentAgreement: Schema.Literals(["agrees", "mismatch", "unverifiable"]),
    skillPath: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...SetupOnboardingBase,
    action: Schema.tag("bind-existing-entry"),
    subjectId: Schema.String,
    skillVersionId: SkillVersionId,
    collectionDisplayName: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...SetupOnboardingBase,
    action: Schema.tag("manage-locally"),
    sourceSelection: Schema.Literal("automatic"),
    sourcePath: Schema.String,
  }),
  Schema.Struct({
    ...SetupOnboardingBase,
    action: Schema.tag("manage-locally"),
    sourceSelection: Schema.Literal("required"),
  }),
  Schema.Struct({
    ...SetupOnboardingBase,
    action: Schema.tag("harness-owned"),
  }),
  Schema.Struct({
    ...SetupOnboardingBase,
    action: Schema.tag("repository-owned"),
  }),
  Schema.Struct({
    ...SetupOnboardingBase,
    action: Schema.tag("blocked"),
    reason: Schema.Literals([
      "invalid-ownership-marker",
      "content-unhashable",
      "ambiguous-library-match",
      "library-skill-name-mismatch",
      "divergent-copies",
      "contested-lock-claim",
    ]),
  }),
  Schema.Struct({
    ...SetupOnboardingBase,
    action: Schema.tag("leave-alone"),
  }),
]);

export const SetupKnownSourceSelection = Schema.Struct({
  name: Schema.String,
  paths: Schema.Array(Schema.String),
  groupKey: Schema.String,
});
export type SetupKnownSourceSelection = typeof SetupKnownSourceSelection.Type;
export type SetupOnboardingCandidate = typeof SetupOnboardingCandidate.Type;

export const SetupResult = Schema.Struct({
  operationId: Schema.optionalKey(Schema.String),
  machineConfig: Schema.Struct({
    path: Schema.String,
    machineId: Schema.optionalKey(MachineId),
    displayName: Schema.optionalKey(Schema.NonEmptyString),
    repositoryRoots: Schema.Array(Schema.String),
    repositoryDecisions: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        status: Schema.Literals(["watched", "ignored"]),
      }),
    ),
    persisted: Schema.Boolean,
  }),
  /** Common folders holding Git repositories, reported when no repository root is configured. */
  suggestedRepositoryRoots: Schema.Array(Schema.String),
  probes: Schema.Array(SetupProbe),
  scan: Schema.Struct({
    complete: Schema.Boolean,
    directoriesExamined: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    repositorySearchDepth: Schema.Literal(1),
    missingRepositories: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  repositories: Schema.Array(SetupRepository),
  repositoryConfigs: Schema.Array(SetupRepositoryConfig),
  authoredCollections: Schema.Array(SetupAuthoredCollection),
  projections: Schema.Array(SetupInstalledSkill),
  reconciliation: Schema.optionalKey(Schema.Array(SetupReconciliationFact)),
  onboarding: Schema.Struct({
    planId: Digest,
    candidates: Schema.Array(SetupOnboardingCandidate),
    /** The command that applies the recommendation, with absolute paths; absent when empty. */
    applyCommand: Schema.optionalKey(Schema.String),
    /** Exactly what `skit setup --apply <planId>` imports and starts managing. */
    recommended: Schema.Struct({
      sources: Schema.Array(
        Schema.Struct({
          /** Identifies the lockfile claim; display `source` and `names` instead. */
          groupKey: Schema.String,
          source: Schema.String,
          names: Schema.Array(Schema.String),
        }),
      ),
      copies: Schema.Array(Schema.Struct({ name: Schema.String, sourcePath: Schema.String })),
    }),
  }),
  locks: Schema.Array(SetupSkillsLock),
  instances: Schema.Array(SetupSkillInstance),
  brokenLinks: Schema.Array(SetupBrokenLink),
  suppressed: Schema.Array(SetupSuppressed),
});
export type SetupResult = typeof SetupResult.Type;

/** What `skit setup --apply` did: what it brought under SKIT, the copies that resulted, and why
 * every other observed skill was left alone. */
export const SetupApplied = Schema.Struct({
  reconciliation: Schema.optionalKey(Schema.Array(SetupReconciliationOutcome)),
  operationId: Schema.optionalKey(Schema.String),
  removed: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String })),
  ),
  recoveryDirectories: Schema.optionalKey(Schema.Array(Schema.String)),
  planId: Digest,
  imported: Schema.Array(
    Schema.Struct({ source: Schema.String, names: Schema.Array(Schema.String) }),
  ),
  added: Schema.Array(Schema.Struct({ name: Schema.String, sourcePath: Schema.String })),
  reconnected: Schema.Array(Schema.Struct({ name: Schema.String, sourcePath: Schema.String })),
  projections: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      target: Schema.String,
      path: Schema.String,
      status: Schema.String,
    }),
  ),
  leftAlone: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      paths: Schema.Array(Schema.String),
      reason: Schema.String,
    }),
  ),
  /**
   * With `--duplicates retire-aliases`: where each retired symlink and its restoration receipt
   * were saved, and any symlink kept because it could not be retired safely.
   */
  aliasRecoveryDirectories: Schema.optionalKey(Schema.Array(Schema.String)),
  preservationWarnings: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, message: Schema.String })),
  ),
  aliasesKept: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, message: Schema.String })),
  ),
});
export type SetupApplied = typeof SetupApplied.Type;
