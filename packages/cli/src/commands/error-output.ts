import { AuthorWorkspaceInvariantFailed } from "@smolai/skit-core/author/workspace-contracts";
import { ArchiveStreamInvalid } from "@smolai/skit-core/universal/consumer";
import { BootstrapFailure } from "../registry/bootstrap-failures.js";
import { HelpDocumentMissing } from "./help-failures.js";
import { UpdateCheckTimedOut } from "../platform/release-failures.js";
import { FindingFingerprintInvalid } from "../library/security/failures.js";
import { FeedbackFailure } from "../feedback/failures.js";
import { InputFailure } from "./input-failures.js";
import { RegistryFailure } from "../registry/failures.js";
import { RegistryRequestFailure } from "../registry/request-failures.js";
import { InteractionFailure } from "../terminal/interaction-failures.js";
import { RecordedFailure } from "../library/recorded-failures.js";
import { SchemaFailure } from "@smolai/skit-core/shared";
import { HarnessDiscoveryFailed } from "@smolai/skit-core/harnesses/discovery-failures";
import { SyncInputInvalid } from "@smolai/skit-core/library/sync/failures";
import { LibraryAuditInvalid } from "@smolai/skit-core/library/audit/failures";
import { RestoreInvalid } from "@smolai/skit-core/library/restore/failures";
import { UpdateFailure } from "@smolai/skit-core/library/update/failures";
import { ImportFailure } from "@smolai/skit-core/library/import/failures";
import { PluginFailure } from "@smolai/skit-core/library/source/plugin-failures";
import { DedicatedInstallerRequired } from "@smolai/skit-core/library/source/installer";
import { UnknownHarness } from "@smolai/skit-core/harnesses/probe-failures";
import {
  SourceRestoreInvalid,
  SourceRestoreReason,
} from "@smolai/skit-core/library/source-restore/failures";
import { SourceFetchFailure } from "@smolai/skit-core/library/source/failures";
import { EditImportFailure } from "@smolai/skit-core/library/edit";
import { InvalidUsageOptions } from "@smolai/skit-core/library/usage/contracts";
import { SetupReviewFailure } from "@smolai/skit-core/library/setup/failures";
import { MachineSettingsFailure } from "@smolai/skit-core/machine-settings/failures";
import { AuthorHistoryFailure } from "@smolai/skit-core/author/history-failures";
import { StoreError } from "@smolai/skit-core/history";
import { SyncFailure } from "@smolai/skit-core/sync/failures";
import { SkitContractError } from "@smolai/skit-core/api";
import { WorkspaceFailure } from "@smolai/skit-core/author/workspace-contracts";
import { AuthorFailure } from "@smolai/skit-core/author/failures";
import { CollectionVersionArchiveInvalid } from "@smolai/skit-core/universal/consumer";
import { ApplyFailure } from "@smolai/skit-core/library/enable";
import { SetEnabledIncomplete } from "@smolai/skit-core/library/enable";
import { InvocationUnavailable } from "@smolai/skit-core/library/session";
import { SourceFailure } from "@smolai/skit-core/library/source/failures";
import { ArtifactDataFailure } from "../platform/artifact-failures.js";
import { PlanDataFailure } from "../library/plan-failures.js";
import { RecoveryInvalid, OperationStopped } from "@smolai/skit-core/library";
import { LibraryDataFailure } from "../library/failures.js";
import { InstalledSkillsDataFailure } from "../library/installed-skill-failures.js";
import { SetupStopped } from "@smolai/skit-core/library/setup";
import { FailureCode } from "@smolai/skit-core/shared";
import { Cause, Schema, SchemaGetter } from "effect";

/** Core permits native acquisition failures; the CLI also owns checked Registry failures. */
const SourceRestoreOutput = Schema.Struct({
  ...SourceRestoreInvalid.fields,
  reason: Schema.Union([
    SourceRestoreReason.cases.SourceFetchFailed.pipe(
      Schema.fieldsAssign({
        failure: Schema.suspend((): Schema.Codec<unknown, unknown> => FailureFacts),
      }),
    ),
    SourceRestoreReason,
  ]),
}).pipe(
  Schema.decodeTo(Schema.declare(Schema.is(SourceRestoreInvalid)), {
    decode: SchemaGetter.transform((fields) => new SourceRestoreInvalid(fields)),
    encode: SchemaGetter.transform((failure) => failure),
  }),
);

/** Stopped operations can nest failures from the CLI source acquisition boundary. */
const SetupStopOutput = Schema.Union([
  SetupStopped.fields.reason.cases.StepFailed.pipe(
    Schema.fieldsAssign({
      error: Schema.suspend((): Schema.Codec<unknown, unknown> => FailureFacts),
    }),
  ),
  SetupStopped.fields.reason,
]).pipe(Schema.decodeTo(Schema.declare(Schema.is(SetupStopped.fields.reason))));
const SetupStoppedOutput = Schema.Struct({ ...SetupStopped.fields, reason: SetupStopOutput }).pipe(
  Schema.decodeTo(Schema.declare(Schema.is(SetupStopped)), {
    decode: SchemaGetter.transform((fields) => new SetupStopped(fields)),
    encode: SchemaGetter.transform((failure) => failure),
  }),
);
const RecoveryOutput = Schema.Struct({
  ...RecoveryInvalid.fields,
  reason: Schema.Union([
    OperationStopped.pipe(Schema.fieldsAssign({ reason: SetupStopOutput })),
    RecoveryInvalid.fields.reason,
  ]),
}).pipe(
  Schema.decodeTo(Schema.declare(Schema.is(RecoveryInvalid)), {
    decode: SchemaGetter.transform((fields) => new RecoveryInvalid(fields)),
    encode: SchemaGetter.transform((failure) => failure),
  }),
);

/** Owner codecs project failure facts only when the command crosses the JSON boundary. */
const FailureFacts: Schema.Codec<unknown, unknown> = Schema.suspend(() =>
  Schema.Union([
    BootstrapFailure,
    HelpDocumentMissing,
    UpdateCheckTimedOut,
    FindingFingerprintInvalid,
    FeedbackFailure,
    RegistryRequestFailure,
    RegistryFailure,
    InputFailure,
    InteractionFailure,
    RecordedFailure,
    SchemaFailure,
    HarnessDiscoveryFailed,
    SyncInputInvalid,
    LibraryAuditInvalid,
    RestoreInvalid,
    UpdateFailure,
    ImportFailure,
    PluginFailure,
    DedicatedInstallerRequired,
    UnknownHarness,
    SourceRestoreOutput,
    SourceFetchFailure,
    EditImportFailure,
    InvalidUsageOptions,
    SetupReviewFailure,
    MachineSettingsFailure,
    AuthorHistoryFailure,
    StoreError,
    SyncFailure,
    SkitContractError,
    WorkspaceFailure,
    AuthorFailure,
    CollectionVersionArchiveInvalid,
    ApplyFailure,
    SetEnabledIncomplete,
    InvocationUnavailable,
    SourceFailure,
    ArtifactDataFailure,
    PlanDataFailure,
    RecoveryOutput,
    InstalledSkillsDataFailure,
    LibraryDataFailure,
    SetupStoppedOutput,
    AuthorWorkspaceInvariantFailed,
    ArchiveStreamInvalid,
    Schema.Defect(),
  ]).pipe(Schema.decodeTo(Schema.Unknown)),
).annotate({ identifier: "CommandFailureFacts" });

/** Retain the full native Cause in-process, including defects and interruptions. */
export const CommandError = Schema.Struct({
  code: FailureCode,
  cause: Schema.toCodecJson(Schema.Cause(FailureFacts, FailureFacts)).pipe(
    Schema.decodeTo(Schema.declare(Cause.isCause)),
  ),
});

/** v1 shipped English strings; v2 carries failure facts and ordered Effect cause reasons. */
export type CommandError = typeof CommandError.Type;

export const errorOutputContract = { id: "skit.error.v2", schema: CommandError } as const;
