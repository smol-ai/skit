/**
 * Library conformance: the real implementation checked against architecture/library.ts.
 *
 * Every method and constructor requirement must match exactly. No migration exemptions.
 */
import type { Effect, Layer } from "effect";
import type { Library as Implementation } from "../../packages/skit/src/library/library.js";
import type { Library, LibraryRequires } from "../library.js";

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

export type Checks = [
  Assert<Equal<Extract<keyof typeof Implementation, "make">, never>>,
  Assert<Equal<MissingMethods<Library, Implementation.Interface>, never>>,
  Assert<Equal<ExtraMethods<Library, Implementation.Interface>, never>>,
  Assert<Equal<Library["read"], Implementation.Interface["read"]>>,
  // Generic target vs overloads; revision and legacy operation-id types still differ.
  Assert<Equal<Library["plan"], Implementation.Interface["plan"]>>,
  // The target wraps every plan in Apply/ApplySynced; ordinary implementation calls take a plan.
  Assert<Equal<Library["apply"], Implementation.Interface["apply"]>>,
  Assert<Equal<Library["import"], Implementation.Interface["import"]>>,
  // Step inputs agree. Restore result identifiers and the public error union still differ.
  Assert<Equal<Library["setup"], Implementation.Interface["setup"]>>,
  // Extra content.plan; inspect/pack add StalePlan, and stage accepts progress or a precomputed content plan.
  Assert<Equal<Library["content"], Implementation.Interface["content"]>>,
  // The implementation also reports LibraryAuditInvalid.
  Assert<Equal<Library["history"], Implementation.Interface["history"]>>,
  Assert<Equal<Library["startup"], Implementation.Interface["startup"]>>,
  Assert<
    Equal<Exclude<Layer.Services<ReturnType<typeof Implementation.layer>>, LibraryRequires>, never>
  >,
];
