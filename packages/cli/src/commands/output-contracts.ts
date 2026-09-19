import {
  AuthorSkitDeleteResponse,
  AuthorSkitSummary,
  Digest,
  InvocationMetadataGeneration,
  LibraryDoctorReport,
  LibraryAuditEvent,
  releasePublishResponseSchema,
  SkillAssessmentDecision,
  SkillAudit,
  SkillSecurityReview,
  SkitValidationDiagnostic,
} from "@smolai/skit-core";
import { Schema } from "effect";
import { AuditReport, AuditReportV1Alpha3 } from "../audit/schema.js";
import { HarnessProbeReport } from "../harness/probe.js";
import { RegistryRemoteChange, RegistryRemoteList } from "../registry/contracts.js";
import { AuthorSyncResult } from "../workflows/author/sync-contract.js";
import { PinPlan, PinResult } from "../workflows/library/pin-contract.js";
import { RemovePlan, RemoveResult } from "../workflows/library/remove-contract.js";
import { CheckResult } from "../workflows/library/check-contract.js";
import { AddPreview, AddResult } from "../workflows/library/add-contract.js";
import { UpdatePlan, UpdateResult } from "../workflows/library/update-contract.js";
import { SyncResult } from "../workflows/library/library-sync-contract.js";
import { ListResult } from "../workflows/library/list-contract.js";
import { SetEnabledPlan, SetEnabledResult } from "../workflows/library/set-enabled-contract.js";
import { RepositoryPolicyResult, SetupResult } from "../workflows/library/setup-contract.js";
import {
  ProjectionRetentionPlan,
  ProjectionRetentionResult,
} from "../workflows/library/projection-retention-contract.js";
import { MachineInventoryResult } from "../workflows/library/machine-inventory-contract.js";

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
    releaseContentHash: Digest,
    skills: Schema.Array(Schema.Struct({ name: Schema.String, contentHash: Digest })),
  }),
  diagnostics: Schema.Array(SkitValidationDiagnostic),
  audits: Schema.Record(Schema.String, SkillAudit),
  assessments: Schema.Record(Schema.String, SkillAssessmentDecision),
});

export const outputContracts = {
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
  add: effectOutput("skit.add.v4", AddResult),
  addPreview: effectOutput("skit.add.preview.v3", AddPreview),
  pull: effectOutput("skit.pull.v4", UpdateResult),
  list: effectOutput("skit.list.v3", ListResult),
  securityReview: effectOutput("skit.security.review.v1", SkillSecurityReview),
  securityAccept: effectOutput("skit.security.accept.v1", SkillSecurityReview),
  inventory: effectOutput("skit.inventory.v5", MachineInventoryResult),
  doctor: effectOutput("skit.doctor.v2", LibraryDoctorReport),
  check: effectOutput("skit.check.v7", CheckResult),
  update: effectOutput("skit.update.v4", UpdateResult),
  updatePlan: effectOutput("skit.update.plan.v4", UpdatePlan),
  projectionRetention: effectOutput(
    "skit.update.projection-retention.v1",
    ProjectionRetentionResult,
  ),
  projectionRetentionPlan: effectOutput(
    "skit.update.projection-retention.plan.v1",
    ProjectionRetentionPlan,
  ),
  pin: effectOutput("skit.pin.v5", PinResult),
  pinPlan: effectOutput("skit.pin.plan.v5", PinPlan),
  remove: effectOutput("skit.remove.v4", RemoveResult),
  removePlan: effectOutput("skit.remove.plan.v4", RemovePlan),
  enable: effectOutput("skit.enable.v3", SetEnabledResult),
  enablePlan: effectOutput("skit.enable.plan.v3", SetEnabledPlan),
  disable: effectOutput("skit.disable.v3", SetEnabledResult),
  disablePlan: effectOutput("skit.disable.plan.v3", SetEnabledPlan),
  publish: effectOutput("skit.publish.v1", releasePublishResponseSchema),
  sync: effectOutput("skit.author.sync.v2", AuthorSyncResult),
  librarySync: effectOutput("skit.library.sync.v4", SyncResult),
  libraryHistory: effectOutput(
    "skit.library.history.v1",
    Schema.Struct({ events: Schema.Array(LibraryAuditEvent) }),
  ),
  setup: effectOutput("skit.setup.v4", SetupResult),
  repositoryPolicy: effectOutput("skit.repository.policy.v1", RepositoryPolicyResult),
  serverBootstrap: effectOutput(
    "skit.server.bootstrap.v1",
    Schema.Struct({
      origin: Schema.String,
      status: Schema.Literals(["complete", "already_complete"]),
    }),
  ),
  authLogin: effectOutput(
    "skit.auth.login.v1",
    Schema.Struct({
      origin: Schema.String,
      tokenPrefix: Schema.String,
      scopes: Schema.Array(Schema.String),
      expiresAt: Schema.optionalKey(Schema.String),
      warning: Schema.optionalKey(Schema.String),
      alias: Schema.optionalKey(Schema.String),
      defaultRegistry: Schema.optionalKey(Schema.String),
    }),
  ),
  authStatus: effectOutput(
    "skit.auth.status.v2",
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
  experimentalHarnessProbe: effectOutput(
    "skit.experimental.harness-probe.v1alpha1",
    HarnessProbeReport,
  ),
  experimentalAudit: effectOutput("skit.experimental.audit.v1alpha1", AuditReport),
  experimentalAuditV1Alpha3: effectOutput("skit.experimental.audit.v1alpha3", AuditReportV1Alpha3),
} as const;

export type AnyOutputContract = (typeof outputContracts)[keyof typeof outputContracts];
export type ContractId = AnyOutputContract["id"];
export type ContractFor<I extends ContractId> = Extract<AnyOutputContract, { readonly id: I }>;
export type ContractDataOf<C extends AnyOutputContract> = C["schema"]["Type"];
export type ContractDataForId<I extends ContractId> = ContractDataOf<ContractFor<I>>;
