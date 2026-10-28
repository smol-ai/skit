import { UsageReport } from "@smolai/skit-core";
import { VersionReport } from "../releases/checker.js";
import {
  AuthorSkitDeleteResponse,
  AuthorSkitSummary,
  Hash,
  InvocationMetadataGeneration,
  LibraryAuditEvent,
  releasePublishResponseSchema,
  SkillAssessmentDecision,
  SkillAudit,
  SkillSecurityReview,
  SkitValidationDiagnostic,
} from "@smolai/skit-core";
import { Schema } from "effect";
import {
  SetupOutput,
  SetupComparisonOutput,
  SetupAppliedOutput,
  SetupReviewOutput,
  SetupFailureOutput,
} from "./setup-actions.js";
import { RecoveryList, RecoveryOutput } from "./recovery-contract.js";
import { SetupUndoOutput } from "./setup-undo-contract.js";
import { AuditReportV1Alpha4 } from "../audit/schema.js";
import { HarnessProbeReport } from "../harness/probe.js";
import { RegistryRemoteChange, RegistryRemoteList } from "../registry/contracts.js";
import { AuthorSyncResult } from "../workflows/author/sync-contract.js";
import { RemovePlan, RemoveResult } from "../workflows/library/remove-contract.js";
import { CheckResult } from "../workflows/library/check-contract.js";
import { AddPreview, AddResult } from "../workflows/library/add-contract.js";
import { UpdatePlan, UpdateResult } from "../workflows/library/update-contract.js";
import { SyncResult } from "../workflows/library/library-sync-contract.js";
import { ListResult } from "../workflows/library/list-contract.js";
import { SetEnabledChange, SetEnabledResult } from "../workflows/library/set-enabled-contract.js";
import { RepositoryPolicyResult } from "../workflows/library/setup-contract.js";
import { EditImportPlan, EditImportResult } from "../workflows/library/import-edit-contract.js";
import { MachineInventoryResult } from "../workflows/library/machine-inventory-contract.js";
import { DoctorReport } from "../workflows/library/doctor-harnesses.js";

function effectOutput<
  const TId extends string,
  TSchema extends Schema.ConstraintCodec<unknown, unknown, any, any>,
>(id: TId, schema: TSchema) {
  return { id, schema } as const;
}

const effectValidation = Schema.Struct({
  valid: Schema.Boolean,
  status: Schema.Literals(["valid", "valid-with-warnings", "policy-blocked", "invalid"]),
  identity: Schema.Struct({
    slug: Schema.String,
    release: Schema.String,
    releaseContentHash: Hash,
    skills: Schema.Array(Schema.Struct({ name: Schema.String, contentHash: Hash })),
  }),
  diagnostics: Schema.Array(SkitValidationDiagnostic),
  audits: Schema.Record(Schema.String, SkillAudit),
  assessments: Schema.Record(Schema.String, SkillAssessmentDecision),
});

export const outputContracts = {
  setupUndo: effectOutput("skit.setup.undo.v2", SetupUndoOutput),
  setupComparison: effectOutput("skit.setup.comparison.v2", SetupComparisonOutput),
  setupReview: effectOutput("skit.setup.review.v2", SetupReviewOutput),
  setupFailed: effectOutput("skit.setup.failed.v1", SetupFailureOutput),
  recoveryList: effectOutput("skit.recovery.list.v1", RecoveryList),
  recovery: effectOutput("skit.recovery.v1", RecoveryOutput),
  usage: effectOutput("skit.usage.v4", UsageReport),
  versionReport: effectOutput("skit.version.v2", VersionReport),
  version: effectOutput("skit.version.v1", Schema.Struct({ version: Schema.String })),
  init: effectOutput(
    "skit.init.v1",
    Schema.Struct({
      path: Schema.String,
      library_registration: Schema.Literals(["registered", "removed"]),
      discovered: Schema.optionalKey(
        Schema.Struct({
          skills: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          skillEntries: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String })),
          readme: Schema.Boolean,
          git: Schema.Boolean,
          skillsLock: Schema.Struct({
            present: Schema.Boolean,
            entries: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          }),
        }),
      ),
    }),
  ),
  validate: effectOutput("skit.validate.v3", effectValidation),
  authorInvocation: effectOutput(
    "skit.author.invocation.v1",
    Schema.Struct({
      path: Schema.String,
      dryRun: Schema.Boolean,
      generated: Schema.Array(InvocationMetadataGeneration),
    }),
  ),
  authorList: effectOutput(
    "skit.author.list.v1",
    Schema.Struct({
      registry: Schema.String,
      skits: Schema.Array(
        Schema.Struct({
          identity: Schema.String,
          visibility: AuthorSkitSummary.fields.visibility,
          draft_revision_id: AuthorSkitSummary.fields.draft_revision_id,
          most_recent_release_version: AuthorSkitSummary.fields.most_recent_release_version,
        }),
      ),
    }),
  ),
  authorDelete: effectOutput("skit.author.delete.v1", AuthorSkitDeleteResponse),
  add: effectOutput("skit.add.v7", AddResult),
  addPreview: effectOutput("skit.add.preview.v4", AddPreview),
  list: effectOutput("skit.list.v7", ListResult),
  securityReview: effectOutput("skit.security.review.v4", SkillSecurityReview),
  securityAccept: effectOutput("skit.security.accept.v4", SkillSecurityReview),
  inventory: effectOutput("skit.inventory.v12", MachineInventoryResult),
  doctor: effectOutput("skit.doctor.v8", DoctorReport),
  check: effectOutput("skit.check.v8", CheckResult),
  update: effectOutput("skit.update.v9", UpdateResult),
  updatePlan: effectOutput("skit.update.plan.v6", UpdatePlan),
  projectionRetention: effectOutput("skit.update.projection-retention.v3", EditImportResult),
  projectionRetentionPlan: effectOutput("skit.update.projection-retention.plan.v3", EditImportPlan),
  remove: effectOutput("skit.remove.v5", RemoveResult),
  removePlan: effectOutput("skit.remove.plan.v5", RemovePlan),
  enable: effectOutput("skit.enable.v10", SetEnabledResult),
  enablePlan: effectOutput("skit.enable.plan.v9", SetEnabledChange),
  disable: effectOutput("skit.disable.v10", SetEnabledResult),
  disablePlan: effectOutput("skit.disable.plan.v9", SetEnabledChange),
  publish: effectOutput("skit.publish.v1", releasePublishResponseSchema),
  sync: effectOutput("skit.author.sync.v3", AuthorSyncResult),
  librarySync: effectOutput("skit.library.sync.v11", SyncResult),
  libraryHistory: effectOutput(
    "skit.library.history.v1",
    Schema.Struct({ events: Schema.Array(LibraryAuditEvent) }),
  ),
  setup: effectOutput("skit.setup.v10", SetupOutput),
  setupApplied: effectOutput("skit.setup.applied.v3", SetupAppliedOutput),
  repositoryPolicy: effectOutput("skit.repository.policy.v1", RepositoryPolicyResult),
  serverBootstrap: effectOutput(
    "skit.server.bootstrap.v1",
    Schema.Struct({
      origin: Schema.String,
      status: Schema.Literals(["complete", "already_complete"]),
    }),
  ),
  authLogin: effectOutput(
    "skit.auth.login.v2",
    Schema.Struct({
      origin: Schema.String,
      tokenPrefix: Schema.String,
      scopes: Schema.Array(Schema.String),
      expiresAt: Schema.optionalKey(Schema.String),
      warning: Schema.optionalKey(Schema.String),
      alias: Schema.optionalKey(Schema.String),
      defaultRegistry: Schema.optionalKey(Schema.String),
      alreadyAuthenticated: Schema.optionalKey(Schema.Boolean),
      credentialPath: Schema.optionalKey(Schema.String),
    }),
  ),
  authLoginPending: effectOutput(
    "skit.auth.login.pending.v1",
    Schema.Struct({
      origin: Schema.String,
      /** The code the user enters at `verificationUri`. */
      userCode: Schema.String,
      verificationUri: Schema.String,
      expiresAt: Schema.String,
      /** Run once the user has approved the code; it waits for approval if they have not yet. */
      next: Schema.String,
    }),
  ),
  authStatus: effectOutput(
    "skit.auth.status.v3",
    Schema.Struct({
      credentials: Schema.Array(
        Schema.Struct({
          origin: Schema.String,
          aliases: Schema.Array(Schema.String),
          tokenPrefix: Schema.String,
          scopes: Schema.Array(Schema.String),
          expiresAt: Schema.optionalKey(Schema.String),
          expiry: Schema.Literals(["known", "unknown"]),
          expired: Schema.Boolean,
          isDefault: Schema.Boolean,
          source: Schema.Literals(["environment", "stored"]),
          /** Where the token is kept: an OS store, the 0600 credential file, or the environment. */
          storage: Schema.Literals(["keychain", "secret-service", "file", "environment"]),
        }),
      ),
    }),
  ),
  registryRemote: effectOutput("skit.registry.remote.v1", RegistryRemoteChange),
  registryList: effectOutput("skit.registry.list.v1", RegistryRemoteList),
  authLogout: effectOutput(
    "skit.auth.logout.v1",
    Schema.Struct({ origin: Schema.String, revoked: Schema.Boolean }),
  ),
  feedbackSend: effectOutput(
    "skit.feedback.send.v1",
    Schema.Struct({ id: Schema.String, createdAt: Schema.String, recipient: Schema.String }),
  ),
  experimentalHarnessProbe: effectOutput(
    "skit.experimental.harness-probe.v1alpha1",
    HarnessProbeReport,
  ),
  experimentalAuditV1Alpha4: effectOutput("skit.experimental.audit.v1alpha4", AuditReportV1Alpha4),
} as const;

export type AnyOutputContract = (typeof outputContracts)[keyof typeof outputContracts];
export type ContractId = AnyOutputContract["id"];
export type ContractFor<I extends ContractId> = Extract<AnyOutputContract, { readonly id: I }>;
export type ContractDataOf<C extends AnyOutputContract> = C["schema"]["Type"];
export type ContractDataForId<I extends ContractId> = ContractDataOf<ContractFor<I>>;
export type ContractKey = keyof typeof outputContracts;
export type ContractData<K extends ContractKey> = ContractDataOf<(typeof outputContracts)[K]>;
/** K itself when it names one contract, `never` for a union, so a key cannot pair with another key's data. */
export type SingleContractKey<K extends ContractKey> = {
  [P in K]: [Exclude<K, P>] extends [never] ? P : never;
}[K];
