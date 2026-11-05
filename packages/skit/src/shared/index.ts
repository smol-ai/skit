/** Shared vocabulary and value operations. No persisted owner state or Node runtime wiring. */
export { BuildInfo } from "./build-info.js";
export { Hash } from "./hash.js";
export { canonicalJson } from "./json.js";
export { isErrno } from "./errno.js";
export { TreeError } from "./tree-error.js";
export { OptionCombinationInvalid } from "./input-failures.js";
export {
  errorMessage,
  FailureTypeId,
  isSkitFailure,
  type FailureCode,
  type SkitFailure,
} from "./failure.js";
