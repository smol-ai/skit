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
