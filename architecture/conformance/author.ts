/**
 * AuthorWorkspace and AuthorHistory conformance: the real owners checked against
 * architecture/author.ts.
 *
 * Every method and constructor requirement must match exactly. No migration exemptions.
 */
import type { Layer } from "effect";
import type * as BuiltHistory from "../../packages/skit/dist/history/history.js";
import type {
  AuthorWorkspace as Implementation,
  AuthorWorkspaceShape,
  WorkspaceLease as ImplementationLease,
} from "../../packages/cli/src/author/workspace.js";
import type {
  AuthorHistory as HistoryImplementation,
  AuthorHistoryShape,
} from "../../packages/cli/src/author/history.js";
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
} from "../author.js";
import type { Assert, ChangedMethods, Equal, ExtraMethods, MissingMethods } from "./library.js";

type Layered = typeof Implementation.layer;
type HistoryLayered = ReturnType<typeof HistoryImplementation.layer>;
/**
 * engineStore is checked on its own: the CLI compiles against the built core (dist) and the
 * contract names its source, and TypeScript treats their error classes as different types. Each
 * side is checked to be exactly the History.Store of what it imports.
 */
type HistoryMethods = Omit<AuthorHistory, "engineStore">;
type ImplementationMethods = Omit<AuthorHistoryShape, "engineStore">;
type HistorySyncState = AuthorHistory["syncState"];
type ImplementationSyncState = AuthorHistoryShape["syncState"];

export type Checks = [
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
  Assert<Equal<ChangedMethods<HistoryMethods, ImplementationMethods>, never>>,
  Assert<Equal<AuthorHistoryShape["engineStore"], BuiltHistory.Store>>,
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
