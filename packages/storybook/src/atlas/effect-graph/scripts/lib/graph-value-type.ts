import type { Type } from "tsrs/sync";

/** A checked non-carrier value can be contracted out of a composition graph.
 * `unknown` is an opaque value type; `any` and compiler error types cannot
 * establish whether an expression carries an Effect or Layer contract. */
export const isGraphValueType = (type: Type | undefined, text: string): type is Type =>
  type !== undefined && !type.isErrorType() && text !== "any" && text !== "error";
