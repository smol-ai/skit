/**
 * Approved size limits, checked by lint/size-ratchet.test.ts and scripts/check-architecture.mjs.
 * Every number may only fall. A change that shrinks a measurement lowers its number here in the same
 * change; raising one, or adding an entry, is an architecture change that needs its own reviewed
 * checkpoint. Print current measurements with:
 *
 *   node scripts/check-architecture.mjs --measure
 *
 * `lines`: non-blank, non-comment source lines under each package's src/.
 * `publicExports`: names each package entry point exports.
 * `featureFiles`: source files reachable from each exported `*CliCommand`, following each imported
 * name to the file that declares it: how many files a reader may open to follow that command.
 */
export const lines = {
  "packages/cli/src": 22024,
  "packages/devtools/src": 1027,
  "packages/skit-server-effect/src": 5740,
  "packages/skit/src": 36133,
  "packages/storybook/src": 793,
  "packages/tui/src": 2452,
};

export const publicExports = {
  "@smolai/skit-core": 616,
  "@smolai/skit-core/harnesses": 12,
  "@smolai/skit-core/library": 9,
  "@smolai/skit-core/library/routing": 17,
  "@smolai/skit-core/library/session": 93,
  "@smolai/skit-core/library/setup": 54,
  "@smolai/skit-core/universal/api": 149,
  "@smolai/skit-core/universal/authoring": 261,
  "@smolai/skit-core/universal/consumer": 234,
};

export const featureFiles = {
  addCliCommand: 272,
  auditCliCommand: 258,
  authLoginCliCommand: 252,
  authLogoutCliCommand: 249,
  authorDeleteCliCommand: 256,
  authorInitCliCommand: 251,
  authorInvocationCliCommand: 249,
  authorListCliCommand: 256,
  authorSyncCliCommand: 256,
  authStatusCliCommand: 249,
  checkCliCommand: 270,
  disableCliCommand: 272,
  doctorCliCommand: 269,
  enableCliCommand: 272,
  feedbackSendCliCommand: 251,
  harnessProbeCliCommand: 249,
  inventoryCliCommand: 269,
  libraryHistoryCliCommand: 249,
  libraryRecoveryCliCommand: 249,
  librarySetupUndoCliCommand: 251,
  librarySyncCliCommand: 261,
  listCliCommand: 277,
  publishCliCommand: 253,
  registryAddCliCommand: 249,
  registryDefaultCliCommand: 249,
  registryListCliCommand: 249,
  registryRemoveCliCommand: 249,
  removeCliCommand: 251,
  repositoryForgetCliCommand: 249,
  repositoryIgnoreCliCommand: 249,
  repositoryListCliCommand: 249,
  repositoryWatchCliCommand: 249,
  securityAcceptCliCommand: 271,
  securityReviewCliCommand: 270,
  serverBootstrapCliCommand: 250,
  setupCliCommand: 279,
  updateCliCommand: 276,
  usageCliCommand: 252,
  validateCliCommand: 249,
  versionCliCommand: 249,
};
