import {
  UsageReport,
  AuthorSkitDeleteResponse,
  AuthorSkitSummary,
  Hash,
  InvocationMetadataGeneration,
  releasePublishResponseSchema,
  SkillAssessmentDecision,
  SkillAudit,
  SkillSecurityReview,
  SkitValidationDiagnostic,
} from "@smolai/skit-core";
import { VersionReport } from "../releases.js";

import { Schema } from "effect";
import { setupOutputContracts } from "../library/setup.js";
import { enableOutputContracts } from "../library/enable.js";
import { recoveryOutputContracts } from "../library/recovery.js";
import { historyOutputContracts } from "../library/history.js";
import { AuditReportV1Alpha4 } from "@smolai/skit-core/audit";
import { HarnessProbeReport } from "@smolai/skit-core/harnesses";
import { RegistryRemoteChange, RegistryRemoteList } from "../registry/contracts.js";
import { AuthorSyncResult } from "../author/contracts.js";
import { removeOutputContracts } from "../library/remove.js";
import { checkOutputContracts } from "../library/check.js";
import { addOutputContracts } from "../library/add.js";
import { updateOutputContracts } from "../library/update.js";
import { syncOutputContracts } from "../library/sync.js";
import { listOutputContracts } from "../library/list.js";
import { RepositoryPolicyResult } from "@smolai/skit-core/library/setup";

import { MachineInventoryResult } from "../library/workflows/machine-inventory-contract.js";
import { DoctorReport } from "../library/workflows/doctor-harnesses.js";

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
  setupUndo: setupOutputContracts.setupUndo,
  setupComparison: setupOutputContracts.setupComparison,
  setupReview: setupOutputContracts.setupReview,
  setupFailed: setupOutputContracts.setupFailed,
  recoveryList: recoveryOutputContracts.recoveryList,
  recovery: recoveryOutputContracts.recovery,
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
    "skit.author.list.v2",
    Schema.Struct({
      registry: Schema.String,
      skits: Schema.Array(
        Schema.Struct({
          identity: Schema.String,
          visibility: AuthorSkitSummary.fields.visibility,
          current_revision_id: AuthorSkitSummary.fields.current_revision_id,
          current_revision_published: AuthorSkitSummary.fields.current_revision_published,
          most_recent_release_version: AuthorSkitSummary.fields.most_recent_release_version,
        }),
      ),
    }),
  ),
  authorDelete: effectOutput("skit.author.delete.v2", AuthorSkitDeleteResponse),
  add: addOutputContracts.add,
  addPreview: addOutputContracts.addPreview,
  list: listOutputContracts.list,
  securityReview: effectOutput("skit.security.review.v4", SkillSecurityReview),
  securityAccept: effectOutput("skit.security.accept.v4", SkillSecurityReview),
  inventory: effectOutput("skit.inventory.v13", MachineInventoryResult),
  doctor: effectOutput("skit.doctor.v9", DoctorReport),
  check: checkOutputContracts.check,
  update: updateOutputContracts.update,
  updatePlan: updateOutputContracts.updatePlan,
  projectionRetention: updateOutputContracts.projectionRetention,
  projectionRetentionPlan: updateOutputContracts.projectionRetentionPlan,
  remove: removeOutputContracts.remove,
  removePlan: removeOutputContracts.removePlan,
  enable: enableOutputContracts.enable,
  enablePlan: enableOutputContracts.enablePlan,
  disable: enableOutputContracts.disable,
  disablePlan: enableOutputContracts.disablePlan,
  publish: effectOutput("skit.publish.v1", releasePublishResponseSchema),
  sync: effectOutput("skit.author.sync.v5", AuthorSyncResult),
  librarySync: syncOutputContracts.librarySync,
  libraryHistory: historyOutputContracts.libraryHistory,
  setup: setupOutputContracts.setup,
  setupApplied: setupOutputContracts.setupApplied,
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
    Schema.Struct({
      id: Schema.String,
      createdAt: Schema.String,
      recipient: Schema.String,
      signedIn: Schema.Boolean,
      email: Schema.optionalKey(Schema.String),
    }),
  ),
  experimentalHarnessProbe: effectOutput(
    "skit.experimental.harness-probe.v1alpha1",
    HarnessProbeReport,
  ),
  experimentalAuditV1Alpha4: effectOutput("skit.experimental.audit.v1alpha4", AuditReportV1Alpha4),
} as const;

export type AnyOutputContract = (typeof outputContracts)[keyof typeof outputContracts];
type ContractId = AnyOutputContract["id"];
type ContractFor<I extends ContractId> = Extract<AnyOutputContract, { readonly id: I }>;
export type ContractDataOf<C extends AnyOutputContract> = C["schema"]["Type"];
export type ContractDataForId<I extends ContractId> = ContractDataOf<ContractFor<I>>;
export type ContractKey = keyof typeof outputContracts;
export type ContractData<K extends ContractKey> = ContractDataOf<(typeof outputContracts)[K]>;
/** K itself when it names one contract, `never` for a union, so a key cannot pair with another key's data. */
export type SingleContractKey<K extends ContractKey> = {
  [P in K]: [Exclude<K, P>] extends [never] ? P : never;
}[K];
