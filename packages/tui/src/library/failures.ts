import { invariantFailure } from "./invariant-failures";
import { ArtifactFailure, artifactFailure } from "./artifact-failures";
import { RecordedFailure, recordedFailure } from "./recorded-failures";
import { SchemaFailure } from "@smolai/skit-core/shared";

import { HarnessDiscoveryFailed } from "@smolai/skit-core/harnesses/discovery-failures";
import { harnessDiscoveryFailure } from "./discovery-failures";
import { SyncInputInvalid } from "@smolai/skit-core/library/sync/failures";
import { syncInputFailure } from "./sync-input-failures.js";
import { SourceFailure } from "@smolai/skit-core/library/source/failures";
import { sourceFailure } from "./source-failures";
import { LibraryAuditInvalid } from "@smolai/skit-core/library/audit/failures";
import { libraryAuditFailure } from "./audit-failures";
import { RestoreInvalid } from "@smolai/skit-core/library/restore/failures";
import { restoreFailure } from "./restore-failures";
import { collectionVersionArchiveFailure } from "./collection-version-archive-failure";
import { UpdateFailure } from "@smolai/skit-core/library/update/failures";
import { updateFailure } from "./update-failures";
import { schemaFailure } from "./schema-failure";
import { ImportFailure } from "@smolai/skit-core/library/import/failures";
import { importFailure } from "./import-failures";
import { PluginFailure } from "@smolai/skit-core/library/source/plugin-failures";
import { DedicatedInstallerRequired } from "@smolai/skit-core/library/source/installer";
import { PnpmSkillManaged } from "@smolai/skit-core/installed-skills/pnpm-failures";
import { pluginFailure } from "./plugin-failures";
import { installerFailure } from "./installer-failure";
import { UnknownHarness } from "@smolai/skit-core/harnesses/probe-failures";
import { unknownHarnessFailure } from "./probe-failures";
import { SourceRestoreInvalid } from "@smolai/skit-core/library/source-restore/failures";
import { sourceRestoreFailure } from "./source-restore-failures";
import { SourceFetchFailure } from "@smolai/skit-core/library/source/failures";
import { sourceFetchFailure } from "./source-fetch-failures";
import { EditImportFailure } from "@smolai/skit-core/library/edit";
import { SyncConflicted, SyncLocalChanged } from "@smolai/skit-core/library/sync";
import { syncConflict } from "./sync-conflicts";
import { editImportFailure } from "./edit-failures";
import { InvalidUsageOptions } from "@smolai/skit-core/library/usage/contracts";
import { usageFailure } from "./usage-failures";
import { SetupReviewFailure } from "@smolai/skit-core/library/setup/failures";
import { setupReviewFailure } from "./setup-review-failures";
import { MachineSettingsFailure } from "@smolai/skit-core/machine-settings/failures";
import { machineSettingsFailure } from "./machine-settings-failures";
import { AuthorHistoryFailure } from "@smolai/skit-core/author/history-failures";
import { StoreError } from "@smolai/skit-core/history";
import { SyncFailure } from "@smolai/skit-core/sync/failures";
import { SkitContractError } from "@smolai/skit-core/api";
import { authorHistoryFailure } from "./author-history-failures";
import { historyStoreFailure } from "./history-store-failures";
import { syncFailure } from "./author-sync-failures";
import { apiContractFailure } from "./api-failures";
import { WorkspaceFailure } from "@smolai/skit-core/author/workspace-contracts";
import { workspaceFailure } from "./workspace-failures";
import { AuthorFailure } from "@smolai/skit-core/author/failures";
import { authorFailure } from "./author-failures";
import { HomeBusy } from "@smolai/skit-core/platform";
import {
  InvalidLibraryState,
  InvalidLibraryStateReason,
  LibrarySubjectNotFound,
} from "@smolai/skit-core/library";
import { AuthorInvocationFailure } from "@smolai/skit-core/library/session";
import { errorMessage } from "@smolai/skit-core/shared";
import { Match, Schema } from "effect";
import { invocationFailure, treeFailure } from "./invocation-failure";

const LibraryReadFailure = Schema.Union([HomeBusy, InvalidLibraryState, LibrarySubjectNotFound]);
const readFailure = Match.type<typeof LibraryReadFailure.Type>().pipe(
  Match.tagsExhaustive({
    HomeBusy: ({ path }) =>
      `Another running SKIT process holds the home writer lock at ${path}. Wait for it to finish, then retry.`,
    "Library.SubjectNotFound": ({ query }) =>
      `No Skill or Collection in the Library matches ${query}`,
    InvalidLibraryState: ({ path, reason }) =>
      `Invalid Library state at ${path}: ${InvalidLibraryStateReason.match(reason, {
        SchemaInvalid: ({ failure }) => schemaFailure(failure),
        ArchiveInvalid: ({ failure }) => collectionVersionArchiveFailure(failure).message,
        InvalidData: ({ issue, tree }) =>
          tree === undefined ? (issue ?? "it cannot be read") : treeFailure(tree),
        UnsupportedVersion: ({ version, oldest, current }) =>
          version === undefined
            ? "Library state has no schema version"
            : `Library state schema v${version}; this version supports v${oldest}–v${current}`,
        MissingRecord: ({ record, at }) =>
          `Missing ${record}${at === undefined ? "" : ` at ${at}`}`,
        ContentChanged: ({ entry }) =>
          `Stored content changed${entry === undefined ? "" : `: ${entry}`}`,
        ContentMissing: ({ entry }) => `Stored content is missing: ${entry}`,
        InvalidSymlink: () => "Recovery directory is redirected",
      })}`,
  }),
);

/** The host rejects with the original owner failure; only the TUI gives it words. */
export const libraryFailure = (error: unknown): string => {
  if (Schema.is(ArtifactFailure)(error)) return artifactFailure(error);
  const invariant = invariantFailure(error);
  if (invariant !== undefined) return `${invariant}\nReport this failure to SKIT's maintainers.`;
  if (Schema.is(SourceFailure)(error)) {
    const formatted = sourceFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(LibraryAuditInvalid)(error)) {
    const formatted = libraryAuditFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(RestoreInvalid)(error)) {
    const formatted = restoreFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(UpdateFailure)(error)) {
    const formatted = updateFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(ImportFailure)(error)) {
    const formatted = importFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(PluginFailure)(error)) {
    const formatted = pluginFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(DedicatedInstallerRequired)(error)) {
    const formatted = installerFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(PnpmSkillManaged)(error))
    return `${error.path} is managed by pnpm (${error.package}); SKIT leaves it in place. Manage this Skill through pnpm's dependency and permission settings.`;
  if (Schema.is(UnknownHarness)(error)) {
    const formatted = unknownHarnessFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(SourceRestoreInvalid)(error)) {
    const formatted = sourceRestoreFailure(error, libraryFailure);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(SourceFetchFailure)(error)) {
    const formatted = sourceFetchFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(RecordedFailure)(error)) {
    const formatted = recordedFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(SchemaFailure)(error)) return schemaFailure(error);
  if (Schema.is(HarnessDiscoveryFailed)(error)) {
    const formatted = harnessDiscoveryFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(SyncInputInvalid)(error)) {
    const formatted = syncInputFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(SyncLocalChanged)(error))
    return "The local Library changed while sync was running. Sync again.";
  if (Schema.is(SyncConflicted)(error)) return error.conflicts.map(syncConflict).join("\n");
  if (Schema.is(EditImportFailure)(error)) {
    const formatted = editImportFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(InvalidUsageOptions)(error)) {
    const formatted = usageFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(SetupReviewFailure)(error)) {
    const formatted = setupReviewFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(MachineSettingsFailure)(error)) {
    const formatted = machineSettingsFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(AuthorHistoryFailure)(error)) {
    const formatted = authorHistoryFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(StoreError)(error)) {
    const formatted = historyStoreFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(SyncFailure)(error)) {
    const formatted = syncFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(SkitContractError)(error)) {
    const formatted = apiContractFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(WorkspaceFailure)(error)) {
    const formatted = workspaceFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(AuthorFailure)(error)) {
    const formatted = authorFailure(error);
    return `${formatted.message}\n${formatted.remediation}`;
  }
  if (Schema.is(LibraryReadFailure)(error)) return readFailure(error);
  if (Schema.is(AuthorInvocationFailure)(error)) return invocationFailure(error);
  return errorMessage(error);
};
