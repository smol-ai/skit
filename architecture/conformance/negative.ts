/**
 * Proof the conformance checks reject what they should. Each @ts-expect-error must stay an error:
 * if a check stops catching its case, tsc fails on the unused directive.
 */
import type { Effect } from "effect";
import type { Library, LibraryRequires } from "../library.js";
import type {
  Assert,
  Equal,
  ExtraMethods,
  MissingMethods,
  UndeclaredRequirements,
} from "./library.js";

// An implementation that adds a state-specific persistence method, like saveConnecting.
type WithSaveConnecting = Library & { readonly saveConnecting: Effect.Effect<void> };
export type RejectsAddedMethod =
  // @ts-expect-error saveConnecting is not in the approved API.
  Assert<Equal<ExtraMethods<Library, WithSaveConnecting>, never>>;

// An implementation missing an approved method.
export type RejectsMissingMethod =
  // @ts-expect-error history is approved but absent.
  Assert<Equal<MissingMethods<Library, Omit<Library, "history">>, never>>;

// A constructor that requires a service the approved API does not allow.
declare const AuthorSync: unique symbol;
type AuthorSync = typeof AuthorSync;
declare const makeWithUndeclared: Effect.Effect<Library, never, AuthorSync>;
export type RejectsUndeclaredRequirement =
  // @ts-expect-error AuthorSync is not an allowed requirement.
  Assert<Equal<UndeclaredRequirements<typeof makeWithUndeclared, LibraryRequires>, never>>;

// And the checks pass for a conforming implementation.
declare const conforming: Effect.Effect<Library, never, LibraryRequires>;
export type AcceptsConforming = [
  Assert<Equal<ExtraMethods<Library, Library>, never>>,
  Assert<Equal<MissingMethods<Library, Library>, never>>,
  Assert<Equal<UndeclaredRequirements<typeof conforming, LibraryRequires>, never>>,
];

// The approved public error boundary translates storage revision conflicts to StalePlan.
// Concrete vocabulary must not reintroduce LibraryChanged through an imported error union.
import type { LibraryChanged } from "../../packages/skit/src/failures.js";
import type { TargetApplyError, TargetPlanError } from "../library-results.js";
export type RejectsPublicStorageConflict = [
  Assert<Equal<Extract<TargetPlanError, LibraryChanged>, never>>,
  Assert<Equal<Extract<TargetApplyError, LibraryChanged>, never>>,
];

// The actual owner requires envelopes, and remote Sync can run only with its receipt.
import type { Library as Implementation } from "../../packages/skit/src/library/library.js";
type EnabledPlan = Extract<Implementation.ReviewedPlan, { readonly _tag: "Enabled" }>;
type AcceptsRequest<Request> = Request extends Implementation.ApplyRequest ? true : false;
export type ApplyConsentChecks = [
  Assert<Equal<AcceptsRequest<EnabledPlan>, false>>,
  Assert<Equal<AcceptsRequest<{ readonly _tag: "Apply"; readonly plan: EnabledPlan }>, true>>,
  Assert<
    Equal<
      AcceptsRequest<{ readonly _tag: "Apply"; readonly plan: Implementation.RemoteSyncPlan }>,
      false
    >
  >,
  Assert<
    Equal<
      AcceptsRequest<{
        readonly _tag: "ApplySynced";
        readonly plan: Implementation.RemoteSyncPlan;
        readonly receipt: Implementation.RemoteReceipt;
      }>,
      true
    >
  >,
  Assert<
    Equal<
      AcceptsRequest<{
        readonly _tag: "ApplySynced";
        readonly plan: Implementation.LocalSyncPlan;
        readonly receipt: Implementation.RemoteReceipt;
      }>,
      false
    >
  >,
  Assert<
    Equal<
      AcceptsRequest<{
        readonly _tag: "Apply";
        readonly plan: EnabledPlan;
        readonly receipt: Implementation.RemoteReceipt;
      }>,
      false
    >
  >,
];
