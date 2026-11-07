/**
 * Library conformance: the real implementation checked against architecture/library.ts.
 *
 * All method names must match. Only the signatures declared in Library are independently
 * checked; LibraryMethod includes additional names without signature coverage. Constructor
 * requirements must stay within LibraryRequires.
 */
import type { Effect, Layer } from "effect";
import type * as Implementation from "../../packages/skit/src/library/library.js";
import type { Library, LibraryMethod, LibraryRequires } from "../library.js";

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

type ExpectedMethods = Record<LibraryMethod, never>;

export type Checks = [
  Assert<Equal<Extract<keyof typeof Implementation, "make">, never>>,
  Assert<Equal<MissingMethods<ExpectedMethods, Implementation.Interface>, never>>,
  Assert<Equal<ExtraMethods<ExpectedMethods, Implementation.Interface>, never>>,
  Assert<Equal<ChangedMethods<Library, Implementation.Interface>, never>>,
  Assert<
    Equal<Exclude<Layer.Services<ReturnType<typeof Implementation.layer>>, LibraryRequires>, never>
  >,
];
