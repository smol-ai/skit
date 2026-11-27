export { AuthorRemoteHome, CanonicalAuthorRemoteHome } from "./remote.js";
export { AuthorFailure } from "./failures.js";
export { AuthorHistoryFailure } from "./history-failures.js";
export { AuthorWorkspaceInvariantFailed, WorkspaceFailure } from "./workspace-contracts.js";
export type { RemovalDecision } from "./inventory.js";
export { createAuthorStateTables } from "./internal/state-tables.js";
export {
  createAuthorHistoryTables,
  createAuthorMetadataTables,
} from "./internal/history-tables.js";
