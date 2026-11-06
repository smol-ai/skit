/**
 * AuthorWorkspace and AuthorHistory conformance: the real owners checked against
 * architecture/author.ts.
 *
 * Every method and constructor requirement must match exactly. No migration exemptions.
 */
import type { Effect, Layer } from "effect";
import type {
  scanAuthorSyncTree,
  AuthorWorkspace as Implementation,
  WorkspaceLease as ImplementationLease,
  AuthorHistory as HistoryImplementation,
} from "../../packages/skit/src/author/index.js";
import type * as CoreHistory from "../../packages/skit/src/history/history.js";

import type {
  AuthorHistory,
  AuthorHistoryConfig,
  AuthorHistoryLayerError,
  AuthorHistoryRequires,
  AuthorWorkspace,
  AuthorWorkspaceLayerError,
  AuthorWorkspaceRequires,
  Services,
  WorkspaceLease,
  SyncScan,
} from "../author.js";
import type { Assert, ChangedMethods, Equal, ExtraMethods, MissingMethods } from "./library.js";

import type { AuthorWorkspaceShape } from "../../packages/skit/src/author/workspace.js";
import type { AuthorHistoryShape } from "../../packages/skit/src/author/history.js";

type Layered = typeof Implementation.layer;
type HistoryLayered = ReturnType<typeof HistoryImplementation.layer>;
type HistorySyncState = AuthorHistory["syncState"];
type ImplementationSyncState = AuthorHistoryShape["syncState"];

export type Checks = [
  Assert<Equal<Effect.Success<ReturnType<typeof scanAuthorSyncTree>>, SyncScan>>,
  Assert<Equal<MissingMethods<AuthorWorkspace, AuthorWorkspaceShape>, never>>,
  Assert<Equal<ExtraMethods<AuthorWorkspace, AuthorWorkspaceShape>, never>>,
  Assert<Equal<ChangedMethods<AuthorWorkspace, AuthorWorkspaceShape>, never>>,
  // The lease is checked method by method too, so a gap names the method rather than `acquire`.
  Assert<Equal<MissingMethods<WorkspaceLease, ImplementationLease>, never>>,
  Assert<Equal<ExtraMethods<WorkspaceLease, ImplementationLease>, never>>,
  Assert<Equal<ChangedMethods<WorkspaceLease, ImplementationLease>, never>>,
  Assert<Equal<Exclude<Layer.Services<Layered>, AuthorWorkspaceRequires>, never>>,
  // Services.AuthorWorkspace is the real tag: same key, and the layer builds exactly it.
  Assert<Equal<typeof Implementation.key, Services.AuthorWorkspace["_contract"]>>,
  Assert<Equal<Layer.Success<Layered>, Implementation>>,
  Assert<Equal<Layer.Error<Layered>, AuthorWorkspaceLayerError>>,
  Assert<Equal<Implementation["Service"], AuthorWorkspaceShape>>,

  Assert<Equal<MissingMethods<AuthorHistory, AuthorHistoryShape>, never>>,
  Assert<Equal<ExtraMethods<AuthorHistory, AuthorHistoryShape>, never>>,
  Assert<Equal<ChangedMethods<AuthorHistory, AuthorHistoryShape>, never>>,
  Assert<Equal<AuthorHistoryShape["engineStore"], CoreHistory.Store>>,
  Assert<
    Equal<MissingMethods<AuthorHistory["backupState"], AuthorHistoryShape["backupState"]>, never>
  >,
  Assert<
    Equal<ExtraMethods<AuthorHistory["backupState"], AuthorHistoryShape["backupState"]>, never>
  >,
  Assert<
    Equal<ChangedMethods<AuthorHistory["backupState"], AuthorHistoryShape["backupState"]>, never>
  >,
  // syncState is checked method by method, so the debt names the steps rather than syncState.
  Assert<Equal<MissingMethods<HistorySyncState, ImplementationSyncState>, never>>,
  Assert<Equal<ExtraMethods<HistorySyncState, ImplementationSyncState>, never>>,
  Assert<Equal<ChangedMethods<HistorySyncState, ImplementationSyncState>, never>>,
  // AuthorWorkspace is the one owner AuthorHistory may require; the stand-in names the real tag.
  Assert<
    Equal<
      Exclude<Layer.Services<HistoryLayered>, Implementation>,
      Exclude<AuthorHistoryRequires, Services.AuthorWorkspace>
    >
  >,
  Assert<Equal<Parameters<typeof HistoryImplementation.layer>, [config: AuthorHistoryConfig]>>,
  Assert<Equal<typeof HistoryImplementation.key, Services.AuthorHistory["_contract"]>>,
  Assert<Equal<Layer.Success<HistoryLayered>, HistoryImplementation>>,
  Assert<Equal<Layer.Error<HistoryLayered>, AuthorHistoryLayerError>>,
  Assert<Equal<HistoryImplementation["Service"], AuthorHistoryShape>>,
];
