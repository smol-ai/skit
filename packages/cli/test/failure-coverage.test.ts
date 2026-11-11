import { expectTypeOf, test } from "vitest";
import type { Effect, Layer, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type * as Library from "@smolai/skit-core/library";
import type * as Author from "@smolai/skit-core/author";
import type * as Setup from "@smolai/skit-core/library/setup";
import type * as Session from "@smolai/skit-core/library/session";
import type * as Harness from "@smolai/skit-core/harnesses";
import type { SkitFailure } from "@smolai/skit-core/shared";
import type { authorSyncApi } from "../src/registry/author-sync.js";
import type { registryFailure } from "../src/registry/failures.js";
import type { registryRequestFailure } from "../src/registry/request-failures.js";
import type { harnessDiscoveryFailure } from "../src/platform/discovery-failures.js";
import type { unknownHarnessFailure, harnessProbeFailure } from "../src/platform/probe-failures.js";
import type { listingUnavailable } from "../src/library/doctor/listing-failures.js";
import type { libraryFailure } from "../src/library/failures.js";
import type { invocationUnavailableFailure } from "../src/library/failures.js";
import type { planFailure } from "../src/library/plan-failures.js";
import type { installedSkillsFailure } from "../src/library/installed-skill-failures.js";
import type { artifactFailure } from "../src/platform/artifact-failures.js";
import type { sourceFailure } from "../src/library/source-failures.js";
import type { sourceContentFailure } from "../src/library/source-fetch-failures.js";
import type { sourceRestoreFailure } from "../src/library/source-restore-failures.js";
import type { importFailure } from "../src/library/import-failures.js";
import type { editImportFailure } from "../src/library/edit-failures.js";
import type { updateFailure } from "../src/library/update-failures.js";
import type { pluginFailure } from "../src/library/plugin-failures.js";
import type { installerFailure } from "../src/library/installer-failure.js";
import type { applyFailure } from "../src/library/apply-failure.js";
import type { recoveryInvalidFailure } from "../src/library/recovery/failures.js";
import type { setupStoppedFailure } from "../src/library/setup/failures.js";
import type { setEnabledIncompleteFailure } from "../src/library/enable/failures.js";
import type { platformFailure } from "../src/platform/failures.js";
import type { collectionVersionArchiveFailure } from "../src/library/collection-version-archive-failure.js";
import type { syncInputFailure } from "../src/library/sync-input-failures.js";
import type { libraryAuditFailure } from "../src/library/audit-failures.js";
import type { restoreFailure } from "../src/library/restore-failures.js";
import type { machineSettingsFailure } from "../src/library/machine-settings-failures.js";
import type { usageFailure } from "../src/library/usage/failures.js";
import type { setupReviewFailure } from "../src/library/setup/review-failures.js";
import type { authorFailure } from "../src/author/failures.js";
import type { workspaceFailure } from "../src/author/workspace-failures.js";
import type { authorHistoryFailure } from "../src/author/history-failures.js";
import type { historyStoreFailure } from "../src/platform/history-failures.js";
import type { syncFailure } from "../src/author/sync-failures.js";
import type { apiContractFailure } from "../src/platform/api-failures.js";
import type { recordedFailure } from "../src/library/recorded-failures.js";
import type { schemaFailureMessages } from "../src/platform/schema-failure.js";

// These are the inputs of real frontend formatters, not another list of error tags. The public
// owner interface below must stay inside this set; a newly returned failure fails CLI typecheck.
type PresentedLibraryFailure =
  | Parameters<typeof libraryFailure>[0]
  | Parameters<typeof invocationUnavailableFailure>[0]
  | Parameters<typeof planFailure>[0]
  | Parameters<typeof installedSkillsFailure>[0]
  | Parameters<typeof artifactFailure>[0]
  | Parameters<typeof sourceFailure>[0]
  | Parameters<typeof sourceContentFailure>[0]
  | Parameters<typeof sourceRestoreFailure>[0]
  | Parameters<typeof importFailure>[0]
  | Parameters<typeof editImportFailure>[0]
  | Parameters<typeof updateFailure>[0]
  | Parameters<typeof pluginFailure>[0]
  | Parameters<typeof installerFailure>[0]
  | Parameters<typeof applyFailure>[0]
  | Parameters<typeof recoveryInvalidFailure>[0]
  | Parameters<typeof setupStoppedFailure>[0]
  | Parameters<typeof setEnabledIncompleteFailure>[0]
  | Parameters<typeof platformFailure>[0]
  | Parameters<typeof collectionVersionArchiveFailure>[0]
  | Parameters<typeof syncInputFailure>[0]
  | Parameters<typeof libraryAuditFailure>[0]
  | Parameters<typeof restoreFailure>[0]
  | Parameters<typeof machineSettingsFailure>[0]
  | Parameters<typeof usageFailure>[0]
  | Parameters<typeof setupReviewFailure>[0]
  | Parameters<typeof authorFailure>[0]
  | Parameters<typeof workspaceFailure>[0]
  | Parameters<typeof authorHistoryFailure>[0]
  | Parameters<typeof historyStoreFailure>[0]
  | Parameters<typeof syncFailure>[0]
  | Parameters<typeof apiContractFailure>[0]
  | Parameters<typeof recordedFailure>[0]
  | Parameters<typeof schemaFailureMessages>[0]
  | Parameters<typeof harnessDiscoveryFailure>[0]
  | Parameters<typeof unknownHarnessFailure>[0]
  // Native failures retain their own engine evidence; they do not require invented core prose.
  | PlatformError
  | Schema.SchemaError;

declare const library: Library.Interface;

type ImportErrors = {
  [K in keyof Library.Interface["import"]]: Effect.Error<
    ReturnType<Library.Interface["import"][K]>
  >;
};
type SessionErrors = {
  [K in keyof Library.Interface["session"]]: Effect.Error<
    ReturnType<Library.Interface["session"][K]>
  >;
};
type ContentErrors = {
  plan: Effect.Error<ReturnType<Library.Interface["content"]["plan"]>>;
  inspect: Effect.Error<ReturnType<Library.Interface["content"]["inspect"]>>;
  pack: Effect.Error<ReturnType<Library.Interface["content"]["pack"]>>;
  // Adapter failures are formatted by the frontend that supplies the adapter, rather than core.
  stage: Effect.Error<ReturnType<typeof library.content.stage<never, never>>>;
};
type RecoveryErrors = {
  list: Effect.Error<Library.Interface["recovery"]["list"]>;
  inspect: Effect.Error<ReturnType<Library.Interface["recovery"]["inspect"]>>;
};
type LibraryErrors = {
  read: Effect.Error<Library.Interface["read"]>;
  history: Effect.Error<Library.Interface["history"]>;
  plan: Effect.Error<ReturnType<Library.Interface["plan"]>>;
  apply: Effect.Error<ReturnType<Library.Interface["apply"]>>;
  import: ImportErrors[keyof ImportErrors];
  setup: Effect.Error<ReturnType<Library.Interface["setup"]>>;
  content: ContentErrors[keyof ContentErrors];
  addSource: Effect.Error<ReturnType<Library.Interface["addSource"]>>;
  importSource: Effect.Error<ReturnType<Library.Interface["importSource"]>>;
  planEnabled: Effect.Error<ReturnType<Library.Interface["planEnabled"]>>;
  skills: Effect.Error<ReturnType<Library.Interface["skills"]>>;
  suggestCleanup: Effect.Error<ReturnType<Library.Interface["suggestCleanup"]>>;
  session: SessionErrors[keyof SessionErrors];
  sync: Effect.Error<ReturnType<typeof library.sync<never, never, never, never, never>>>;
  syncSession: Effect.Error<ReturnType<Library.Interface["syncSession"]>>;
  remove: Effect.Error<ReturnType<Library.Interface["remove"]>>;
  update: Effect.Error<ReturnType<typeof library.update<never, never>>>;
  updateAuthoredSkills: Effect.Error<ReturnType<Library.Interface["updateAuthoredSkills"]>>;
  edit: Effect.Error<ReturnType<Library.Interface["edit"]>>;
  check: Effect.Error<ReturnType<typeof library.check<never, never>>>;
  previewSourceUpdates: Effect.Error<ReturnType<typeof library.previewSourceUpdates<never, never>>>;
  securityReview: Effect.Error<ReturnType<Library.Interface["securityReview"]>>;
  acceptSecurityFinding: Effect.Error<ReturnType<Library.Interface["acceptSecurityFinding"]>>;
  descriptionLoad: Effect.Error<ReturnType<Library.Interface["descriptionLoad"]>>;
  workspaceClaims: Effect.Error<ReturnType<Library.Interface["workspaceClaims"]>>;
  installedSkills: Effect.Error<Library.Interface["installedSkills"]>;
  manifest: Effect.Error<Library.Interface["manifest"]>;
  skillsShCollectionIds: Effect.Error<Library.Interface["skillsShCollectionIds"]>;
  list: Effect.Error<ReturnType<Library.Interface["list"]>>;
  inventory: Effect.Error<Library.Interface["inventory"][keyof Library.Interface["inventory"]]>;
  recovery: RecoveryErrors[keyof RecoveryErrors];
  startup: never;
};

type MissingLibraryFailure = Exclude<LibraryErrors[keyof LibraryErrors], PresentedLibraryFailure>;

type AuthorErrors = {
  layer: Layer.Error<ReturnType<typeof Author.authorLayer>>;
  workspaceLayer: Layer.Error<typeof Author.authorWorkspaceLayer>;
  read: Effect.Error<ReturnType<typeof Author.readAuthorWorkspace>>;
  refresh: Effect.Error<ReturnType<typeof Author.refreshAuthorWorkspace>>;
  backup: Effect.Error<ReturnType<typeof Author.backupAuthorWorkspace<never>>>;
  init: Effect.Error<ReturnType<typeof Author.initSkit>>;
  initialize: Effect.Error<ReturnType<typeof Author.initializeAuthorWorkspace>>;
  invocation: Effect.Error<ReturnType<typeof Author.generateAuthorInvocation>>;
  destination: Effect.Error<ReturnType<typeof Author.parseAuthorDestination>>;
  sync: Effect.Error<ReturnType<typeof Author.syncAuthorWorkspace<never, never, never>>>;
  update: Effect.Error<ReturnType<typeof Author.updateAuthorWorkspace<never, never, never>>>;
  publish: Effect.Error<ReturnType<typeof Author.publishAuthorWorkspace<never, never, never>>>;
  watch: Effect.Error<ReturnType<typeof Author.watchAuthorWorkspace<never, never, never, never>>>;
  list: Effect.Error<ReturnType<typeof Author.listAuthorSkits<never, never>>>;
  delete: Effect.Error<ReturnType<typeof Author.deleteAuthorSkit<never, never, never, never>>>;
  archive: Effect.Error<ReturnType<typeof Author.createSkitArchive>>;
  validate: Effect.Error<ReturnType<typeof Author.validateSkitDirectory>>;
  descriptor: Effect.Error<ReturnType<typeof Author.readSkitDescriptor>>;
};
type AuthorOperationErrors = AuthorErrors[keyof AuthorErrors];

type SetupErrors = {
  scan: Effect.Error<ReturnType<typeof Setup.runSetup>>;
  open: Effect.Error<ReturnType<typeof Setup.openSetupReview>>;
  approved: Effect.Error<ReturnType<typeof Setup.openApprovedSetupReview>>;
  apply: Effect.Error<ReturnType<typeof Setup.applySetupPlan>>;
  undo: Effect.Error<ReturnType<typeof Setup.prepareSetupUndo>>;
  import: Effect.Error<ReturnType<typeof Setup.setupImportRequests>>;
  prepare: Effect.Error<ReturnType<Setup.SetupReview["prepare"]>>;
  explicit: Effect.Error<ReturnType<Setup.SetupReview["prepareExplicit"]>>;
  recommended: Effect.Error<ReturnType<Setup.SetupReview["prepareRecommended"]>>;
  refresh: Effect.Error<ReturnType<Setup.SetupReview["refresh"]>>;
};
type SetupOperationErrors = SetupErrors[keyof SetupErrors];

test("Author and Setup public workflows cannot return an unformatted core failure", () => {
  expectTypeOf<AuthorOperationErrors>().not.toBeAny();
  expectTypeOf<AuthorOperationErrors>().not.toBeUnknown();
  expectTypeOf<Exclude<AuthorOperationErrors, PresentedLibraryFailure>>().toEqualTypeOf<never>();
  expectTypeOf<SetupOperationErrors>().not.toBeAny();
  expectTypeOf<SetupOperationErrors>().not.toBeUnknown();
  expectTypeOf<Exclude<SetupOperationErrors, PresentedLibraryFailure>>().toEqualTypeOf<never>();
  // Session outcomes carry checked failures as values, rather than in the Effect error channel.
  expectTypeOf<Session.AuthorInvocationFailure>().toExtend<PresentedLibraryFailure>();
  expectTypeOf<
    Exclude<
      Extract<Session.LibraryActionOutcome, { kind: "failed" }>["failure"],
      PresentedLibraryFailure
    >
  >().toEqualTypeOf<never>();
});

test("all public Library operations have frontend words for their core failures", () => {
  expectTypeOf<keyof LibraryErrors>().toEqualTypeOf<keyof Library.Interface>();
  expectTypeOf<keyof ContentErrors>().toEqualTypeOf<keyof Library.Interface["content"]>();
  expectTypeOf<keyof RecoveryErrors>().toEqualTypeOf<keyof Library.Interface["recovery"]>();
  expectTypeOf<LibraryErrors[keyof LibraryErrors]>().not.toBeAny();
  expectTypeOf<LibraryErrors[keyof LibraryErrors]>().not.toBeUnknown();
  expectTypeOf<MissingLibraryFailure>().toEqualTypeOf<never>();
  expectTypeOf<Layer.Error<ReturnType<typeof Library.layer>>>().toExtend<PresentedLibraryFailure>();
  // Guard against a vacuous proof through an unknown or overly broad formatter input.
  expectTypeOf<
    {
      readonly _tag: "NewUnhandledLibraryFailure";
    } & SkitFailure
  >().not.toExtend<PresentedLibraryFailure>();
});

test("native Registry adapter and embedded Harness failures retain formatter coverage", () => {
  type ForeignFailure = SkitFailure & { readonly _tag: "ForeignRegistryFailure" };
  type AuthorWithForeignTransport = Effect.Error<
    ReturnType<typeof Author.syncAuthorWorkspace<never, never, ForeignFailure>>
  >;
  expectTypeOf<
    Extract<AuthorWithForeignTransport, ForeignFailure>
  >().toEqualTypeOf<ForeignFailure>();
  type Adapter = Effect.Success<ReturnType<typeof authorSyncApi>>;
  type TransportError = Effect.Error<Adapter["remote"]["current"]>;
  expectTypeOf<TransportError>().not.toBeAny();
  expectTypeOf<TransportError>().not.toBeUnknown();
  expectTypeOf<TransportError>().toExtend<
    | Parameters<typeof registryFailure>[0]
    | Parameters<typeof registryRequestFailure>[0]
    | PresentedLibraryFailure
  >();
  expectTypeOf<
    Effect.Error<ReturnType<typeof Harness.probeRequestedHarnesses>>
  >().toExtend<PresentedLibraryFailure>();
  expectTypeOf<
    Effect.Error<ReturnType<typeof Harness.readCodexSkills>>
  >().toExtend<PresentedLibraryFailure>();
  expectTypeOf<NonNullable<Harness.HarnessProbeResult["failure"]>>().toExtend<
    Parameters<typeof harnessProbeFailure>[0]
  >();
  expectTypeOf<Extract<Harness.ListingBudget, { _tag: "Unavailable" }>["reason"]>().toExtend<
    Parameters<typeof listingUnavailable>[0]
  >();
});
