/**
 * Library conformance: the real implementation checked against architecture/library.ts.
 *
 * Every method and constructor requirement must match exactly. No migration exemptions.
 */
import type { Effect, Layer } from "effect";
import type * as Implementation from "../../packages/skit/src/library/library.js";
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
  Assert<Equal<Library["plan"], Implementation.Interface["plan"]>>,
  Assert<Equal<Library["apply"], Implementation.Interface["apply"]>>,
  Assert<Equal<Library["import"], Implementation.Interface["import"]>>,
  Assert<Equal<Library["setup"], Implementation.Interface["setup"]>>,
  Assert<Equal<Library["content"], Implementation.Interface["content"]>>,
  Assert<Equal<Library["history"], Implementation.Interface["history"]>>,
  Assert<Equal<Library["recovery"], Implementation.Interface["recovery"]>>,
  Assert<Equal<Library["startup"], Implementation.Interface["startup"]>>,
  Assert<
    Equal<Exclude<Layer.Services<ReturnType<typeof Implementation.layer>>, LibraryRequires>, never>
  >,
];
