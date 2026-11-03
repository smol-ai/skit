/**
 * AuthorWorkspace conformance: the real owner checked against architecture/author.ts.
 *
 * Same rules as library.ts: each gap between today's code and the approved API is listed as
 * debt, NOT approved, and the checks are exact, so debt only shrinks, in the change that closes it.
 * AuthorHistory joins this file when it is built.
 */
import type { Layer } from "effect";
import type {
  AuthorWorkspace as Implementation,
  AuthorWorkspaceShape,
  WorkspaceLease as ImplementationLease,
} from "../../packages/cli/src/author/workspace.js";
import type {
  AuthorWorkspace,
  AuthorWorkspaceLayerError,
  AuthorWorkspaceRequires,
  Services,
  WorkspaceLease,
} from "../author.js";
import type { Assert, ChangedMethods, Equal, ExtraMethods, MissingMethods } from "./library.js";

type Layered = typeof Implementation.layer;

// ── Debt: today's gaps, to be closed by migration ─────────────────────────────────────────────
type MissingDebt = never;
type ExtraDebt = never;
type ChangedDebt = never;
type RequirementDebt = never;

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
];
