/**
 * Library conformance: the real implementation checked against architecture/library.ts.
 *
 * Each gap between today's code and the approved API is listed as debt, NOT approved. The checks
 * are exact: closing a gap without removing its debt entry fails, and so does opening a new one.
 * So debt only shrinks, and only in the same change that closes it.
 */
import type { Effect } from "effect";
import type { Library as Implementation } from "../../packages/skit/src/library/library.js";
import type { Library, LibraryRequires } from "../library.js";
import type { InstalledSkills } from "../../packages/skit/src/library/installed-skills.js";

/** Exactly equal, including literal unions; `never` equals only `never`. */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type Assert<T extends true> = T;

/** Methods the approved API has and the implementation lacks. */
export type MissingMethods<Contract, Actual> = Exclude<keyof Contract, keyof Actual>;
/** Methods the implementation has and the approved API does not: e.g. an added saveConnecting. */
export type ExtraMethods<Contract, Actual> = Exclude<keyof Actual, keyof Contract>;
/** Shared methods whose signatures differ from the approved API. */
export type ChangedMethods<Contract, Actual> = {
  [K in keyof Contract & keyof Actual]: Equal<Contract[K], Actual[K]> extends true ? never : K;
}[keyof Contract & keyof Actual];
/** Services the constructor requires that the approved API does not allow. */
export type UndeclaredRequirements<Make, Allowed> = Exclude<Effect.Services<Make>, Allowed>;

// ── Debt: today's gaps, to be closed by migration ─────────────────────────────────────────────
type MissingDebt = never;
type ExtraDebt = never;
// plan/apply now include Undo; their legacy plan shapes and recovery UUIDs still differ from the
// target generic signatures. The journal's machine evidence is compatibility data, not an owner write.
// setup: core result and error types (the contract's are Ref placeholders).
// startup: a stopped reason's StepFailed error is saved as JSON (Schema.Defect), so it reads back
// as unknown, not the contract's error union.
// history retains the existing audit reader's LibraryAuditInvalid failure (path + line).
// The target omits that failure; keep the mismatch explicit pending contract review.
// content is implemented: its concrete restoration errors replace Ref placeholders; it also
// preserves restore progress and offers a passive availability plan for sync's preview count.
// Those signature differences require explicit target review, not casts or a relaxed assertion.
type ChangedDebt = "plan" | "apply" | "setup" | "history" | "content";
// InstalledSkills is built inside Library.layer from routing; `make` still takes it from context.
type RequirementDebt = InstalledSkills.Service;

export type Checks = [
  Assert<Equal<MissingMethods<Library, Implementation.Interface>, MissingDebt>>,
  Assert<Equal<ExtraMethods<Library, Implementation.Interface>, ExtraDebt>>,
  Assert<Equal<ChangedMethods<Library, Implementation.Interface>, ChangedDebt>>,
  Assert<
    Equal<
      UndeclaredRequirements<ReturnType<typeof Implementation.make>, LibraryRequires>,
      RequirementDebt
    >
  >,
];
