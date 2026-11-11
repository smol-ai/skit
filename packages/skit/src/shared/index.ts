/** Shared vocabulary and value operations. No persisted owner state or Node runtime wiring. */
export { BuildInfo } from "./build-info.js";
export { Hash } from "./hash.js";
export { canonicalJson } from "./json.js";
export { isErrno } from "./errno.js";
export { TreeError, TreeErrorReason, GitInspectionIssue } from "./tree-error.js";
export {
  errorMessage,
  FailureTypeId,
  isSkitFailure,
  FailureCode,
  type SkitFailure,
} from "./failure.js";

export {
  SchemaIssueFact,
  SchemaIssueReason,
  ExpectedSchemaType,
  SchemaFailure,
} from "./schema-issue.js";
