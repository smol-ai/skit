import { invariantFailure } from "../platform/invariant-failures.js";
import { BootstrapFailure, bootstrapFailure } from "../registry/bootstrap-failures.js";
import { HelpDocumentMissing, helpDocumentFailure } from "./help-failures.js";
import { UpdateCheckTimedOut, releaseCheckFailure } from "../platform/release-failures.js";
import {
  FindingFingerprintInvalid,
  findingFingerprintFailure,
} from "../library/security/failures.js";
import { FeedbackFailure, feedbackFailure } from "../feedback/failures.js";
import { InputFailure, inputFailure } from "./input-failures.js";
import { RegistryFailure, registryFailure } from "../registry/failures.js";
import { RegistryRequestFailure, registryRequestFailure } from "../registry/request-failures.js";
import { InteractionFailure, interactionFailure } from "../terminal/interaction-failures.js";
import { describeFailure } from "../terminal/failure.js";
import type { FailureDescription } from "../terminal/failure.js";
import { RecordedFailure, recordedFailure } from "../library/recorded-failures.js";
import { SchemaFailure } from "@smolai/skit-core/shared";
import { schemaFailureMessages } from "../platform/schema-failure.js";
import { Block } from "../terminal/blocks.js";
import { HarnessDiscoveryFailed } from "@smolai/skit-core/harnesses/discovery-failures";
import { harnessDiscoveryFailure } from "../platform/discovery-failures.js";
import { SyncInputInvalid } from "@smolai/skit-core/library/sync/failures";
import { syncInputFailure } from "../library/sync-input-failures.js";
import { LibraryAuditInvalid } from "@smolai/skit-core/library/audit/failures";
import { libraryAuditFailure } from "../library/audit-failures.js";
import { RestoreInvalid } from "@smolai/skit-core/library/restore/failures";
import { restoreFailure } from "../library/restore-failures.js";
import { UpdateFailure } from "@smolai/skit-core/library/update/failures";
import { updateFailure } from "../library/update-failures.js";
import { ImportFailure } from "@smolai/skit-core/library/import/failures";
import { importFailure } from "../library/import-failures.js";
import { PluginFailure } from "@smolai/skit-core/library/source/plugin-failures";
import { DedicatedInstallerRequired } from "@smolai/skit-core/library/source/installer";
import { pluginFailure } from "../library/plugin-failures.js";
import { installerFailure } from "../library/installer-failure.js";
import { UnknownHarness } from "@smolai/skit-core/harnesses/probe-failures";
import { unknownHarnessFailure } from "../platform/probe-failures.js";
import { SourceRestoreInvalid } from "@smolai/skit-core/library/source-restore/failures";
import { sourceRestoreFailure } from "../library/source-restore-failures.js";
import { SourceFetchFailure } from "@smolai/skit-core/library/source/failures";
import { sourceContentFailure } from "../library/source-fetch-failures.js";
import { EditImportFailure } from "@smolai/skit-core/library/edit";
import { editImportFailure } from "../library/edit-failures.js";
import { InvalidUsageOptions } from "@smolai/skit-core/library/usage/contracts";
import { usageFailure } from "../library/usage/failures.js";
import { SetupReviewFailure } from "@smolai/skit-core/library/setup/failures";
import { setupReviewFailure } from "../library/setup/review-failures.js";
import { MachineSettingsFailure } from "@smolai/skit-core/machine-settings/failures";
import { machineSettingsFailure } from "../library/machine-settings-failures.js";
import { AuthorHistoryFailure } from "@smolai/skit-core/author/history-failures";
import { StoreError } from "@smolai/skit-core/history";
import { SyncFailure } from "@smolai/skit-core/sync/failures";
import { SkitContractError } from "@smolai/skit-core/api";
import { authorHistoryFailure } from "../author/history-failures.js";
import { historyStoreFailure } from "../platform/history-failures.js";
import { syncFailure } from "../author/sync-failures.js";
import { apiContractFailure } from "../platform/api-failures.js";
import { WorkspaceFailure } from "@smolai/skit-core/author/workspace-contracts";
import { workspaceFailure } from "../author/workspace-failures.js";
import { AuthorFailure } from "@smolai/skit-core/author/failures";
import { authorFailure } from "../author/failures.js";
import { CollectionVersionArchiveInvalid } from "@smolai/skit-core/universal/consumer";
import { collectionVersionArchiveFailure } from "../library/collection-version-archive-failure.js";
import { ApplyFailure } from "@smolai/skit-core/library/enable";
import { applyFailure } from "../library/apply-failure.js";
import { SetEnabledIncomplete } from "@smolai/skit-core/library/enable";
import { setEnabledIncompleteFailure } from "../library/enable/failures.js";
import { InvocationUnavailable } from "@smolai/skit-core/library/session";
import { SourceFailure } from "@smolai/skit-core/library/source/failures";
import { sourceFailure } from "../library/source-failures.js";
import { ArtifactDataFailure, artifactFailure } from "../platform/artifact-failures.js";
import { PlanDataFailure, planFailure } from "../library/plan-failures.js";
import { RecoveryInvalid } from "@smolai/skit-core/library";
import { errorMessage } from "@smolai/skit-core/shared";
import { recoveryInvalidFailure } from "../library/recovery/failures.js";
import { Schema } from "effect";
import {
  LibraryDataFailure,
  libraryFailure,
  invocationUnavailableFailure,
} from "../library/failures.js";
import {
  InstalledSkillsDataFailure,
  installedSkillsFailure,
} from "../library/installed-skill-failures.js";

/** The migrated owners' formatters, shared by command failures and embedded recorded failures. */
export const dataFailure = (error: unknown): FailureDescription | undefined => {
  const invariant = invariantFailure(error);
  if (invariant !== undefined) return invariant;
  if (Schema.is(BootstrapFailure)(error)) return bootstrapFailure(error);
  if (Schema.is(HelpDocumentMissing)(error)) return helpDocumentFailure(error);
  if (Schema.is(UpdateCheckTimedOut)(error)) return releaseCheckFailure(error);
  if (Schema.is(FindingFingerprintInvalid)(error)) return findingFingerprintFailure(error);
  if (Schema.is(FeedbackFailure)(error)) return feedbackFailure(error);
  if (Schema.is(RegistryRequestFailure)(error)) return registryRequestFailure(error);
  if (Schema.is(RegistryFailure)(error)) return registryFailure(error);
  if (Schema.is(InputFailure)(error)) return inputFailure(error);
  if (Schema.is(InteractionFailure)(error)) return interactionFailure(error);
  if (Schema.is(RecordedFailure)(error)) return recordedFailure(error);
  if (Schema.is(SchemaFailure)(error))
    return describeFailure({
      summary: ["The data does not match its required format"],
      details: [
        Block.List({ items: schemaFailureMessages(error).map((message) => ({ text: [message] })) }),
      ],
      next: ["Correct the reported data before retrying."],
    });
  if (Schema.is(HarnessDiscoveryFailed)(error)) return harnessDiscoveryFailure(error);
  if (Schema.is(SyncInputInvalid)(error)) return syncInputFailure(error);
  if (Schema.is(LibraryAuditInvalid)(error)) return libraryAuditFailure(error);
  if (Schema.is(RestoreInvalid)(error)) return restoreFailure(error);
  if (Schema.is(UpdateFailure)(error)) return updateFailure(error);
  if (Schema.is(ImportFailure)(error)) return importFailure(error);
  if (Schema.is(PluginFailure)(error)) return pluginFailure(error);
  if (Schema.is(DedicatedInstallerRequired)(error)) return installerFailure(error);
  if (Schema.is(UnknownHarness)(error)) return unknownHarnessFailure(error);
  if (Schema.is(SourceRestoreInvalid)(error))
    return sourceRestoreFailure(
      error,
      (failure) =>
        dataFailure(failure) ?? describeFailure({ summary: [errorMessage(failure)], next: [] }),
    );
  if (Schema.is(SourceFetchFailure)(error)) return sourceContentFailure(error);
  if (Schema.is(EditImportFailure)(error)) return editImportFailure(error);
  if (Schema.is(InvalidUsageOptions)(error)) return usageFailure(error);
  if (Schema.is(SetupReviewFailure)(error)) return setupReviewFailure(error);
  if (Schema.is(MachineSettingsFailure)(error)) return machineSettingsFailure(error);
  if (Schema.is(AuthorHistoryFailure)(error)) return authorHistoryFailure(error);
  if (Schema.is(StoreError)(error)) return historyStoreFailure(error);
  if (Schema.is(SyncFailure)(error)) return syncFailure(error);
  if (Schema.is(SkitContractError)(error)) return apiContractFailure(error);
  if (Schema.is(WorkspaceFailure)(error)) return workspaceFailure(error);
  if (Schema.is(AuthorFailure)(error)) return authorFailure(error);
  if (Schema.is(CollectionVersionArchiveInvalid)(error))
    return collectionVersionArchiveFailure(error);
  if (Schema.is(ApplyFailure)(error)) return applyFailure(error);
  if (Schema.is(SetEnabledIncomplete)(error))
    return setEnabledIncompleteFailure(error, applyFailure);
  if (Schema.is(InvocationUnavailable)(error)) {
    return invocationUnavailableFailure(
      error,
      (failure) =>
        dataFailure(failure) ??
        describeFailure({
          summary: [errorMessage(failure)],
          next: ["Correct the reported diagnostics in the source before retrying."],
        }),
    );
  }
  if (Schema.is(SourceFailure)(error)) return sourceFailure(error);
  if (Schema.is(ArtifactDataFailure)(error)) return artifactFailure(error);
  if (Schema.is(PlanDataFailure)(error)) return planFailure(error);
  if (Schema.is(RecoveryInvalid)(error))
    return recoveryInvalidFailure(
      error,
      (cause) =>
        dataFailure(cause) ?? describeFailure({ summary: [errorMessage(cause)], next: [] }),
    );
  if (Schema.is(InstalledSkillsDataFailure)(error)) return installedSkillsFailure(error);
  if (Schema.is(LibraryDataFailure)(error)) return libraryFailure(error);
  return undefined;
};
