/**
 * AuthorWorkspace and AuthorHistory conformance: the real owners checked against
 * architecture/author.ts.
 *
 * Same rules as library.ts: each gap between today's code and the approved API is listed as
 * debt, NOT approved, and the checks are exact, so debt only shrinks, in the change that closes it.
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

// ── Debt: today's gaps, to be closed by migration ─────────────────────────────────────────────
type MissingDebt = never;
type ExtraDebt = never;
type ChangedDebt = never;
type RequirementDebt = never;

/**
 * The home lock is withLibraryWriterLock until the home-lock function exists (D3): capture
 * (through MachineSettings.ensureIdentity) and every checkpoint step fail LibraryBusy where the
 * contract has HomeBusy, or nothing for capture.
 */
type HistoryChangedDebt = "capture" | "syncState";
type SyncStateChangedDebt = "save" | "prepareWrite";

export type Checks = [
  Assert<Equal<MissingMethods<AuthorWorkspace, AuthorWorkspaceShape>, MissingDebt>>,
  Assert<Equal<ExtraMethods<AuthorWorkspace, AuthorWorkspaceShape>, ExtraDebt>>,
  Assert<Equal<ChangedMethods<AuthorWorkspace, AuthorWorkspaceShape>, ChangedDebt>>,
  // The lease is checked method by method too, so a gap names the method rather than `acquire`.
  Assert<Equal<MissingMethods<WorkspaceLease, ImplementationLease>, never>>,
  Assert<Equal<ExtraMethods<WorkspaceLease, ImplementationLease>, never>>,
  Assert<Equal<ChangedMethods<WorkspaceLease, ImplementationLease>, never>>,
  Assert<Equal<Exclude<Layer.Services<Layered>, AuthorWorkspaceRequires>, RequirementDebt>>,
  // Services.AuthorWorkspace is the real tag: same key, and the layer builds exactly it.
  Assert<Equal<typeof Implementation.key, Services.AuthorWorkspace["_contract"]>>,
  Assert<Equal<Layer.Success<Layered>, Implementation>>,
  Assert<Equal<Layer.Error<Layered>, AuthorWorkspaceLayerError>>,
  Assert<Equal<Implementation["Service"], AuthorWorkspaceShape>>,

  Assert<Equal<MissingMethods<AuthorHistory, AuthorHistoryShape>, never>>,
  Assert<Equal<ExtraMethods<AuthorHistory, AuthorHistoryShape>, never>>,
  Assert<Equal<ChangedMethods<HistoryMethods, ImplementationMethods>, HistoryChangedDebt>>,
  Assert<Equal<AuthorHistoryShape["engineStore"], BuiltHistory.Store>>,
  // syncState is checked method by method, so the debt names the steps rather than syncState.
  Assert<Equal<MissingMethods<HistorySyncState, ImplementationSyncState>, never>>,
  Assert<Equal<ExtraMethods<HistorySyncState, ImplementationSyncState>, never>>,
  Assert<Equal<ChangedMethods<HistorySyncState, ImplementationSyncState>, SyncStateChangedDebt>>,
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
