/**
 * Supported source-level seam for the workspace TUI and Storybook applications.
 *
 * These prototypes deliberately reuse CLI orchestration. Keeping their imports here ensures that
 * every path reaches core through the CLI package's `@smolai/skit-core` dependency instead of
 * loading core source and built output as two runtime identities.
 */
export { LibraryActor, libraryStoreLayer, skitLayer } from "@smolai/skit-core";

export { detectInstalledHarnessesEffect } from "./harness/catalog.js";
export { errorMessage } from "./presentation/command-errors.js";
export { auditLocalCapabilitiesV1Alpha4Effect } from "./audit/local.js";
export type {
  AuditEntryV1Alpha4,
  AuditMcpServerV1Alpha4,
  AuditSkillV1Alpha4,
} from "./audit/schema.js";
export {
  probeHarnessEffect,
  type HarnessProbeResult,
  type ProbeableHarness,
} from "./harness/probe.js";
export {
  openLibrarySession,
  refreshLibrarySession,
  proposeLibraryEnable,
  proposeLibraryDisable,
  proposeLibraryInvocation,
  confirmLibraryChange,
  cancelLibraryChange,
  type LibraryActionOutcome,
  type LibraryBindingRow,
  type LibrarySessionState,
  type LibrarySkillRow,
  type PendingLibraryChange,
} from "./workflows/library/session.js";
export {
  DESTINATION_QUESTION,
  destinationLabel,
  invocationChoices,
  invocationBriefing,
  invocationEligibleBindings,
  invocationRowSummary,
  scopeChoices,
  type Scope,
} from "./library/read-model.js";
export type { InvocationOption } from "./invocation/policy.js";

export {
  defaultTerminalEnvironment,
  renderFailureFrame,
  renderResultFrame,
  type TerminalEnvironment,
} from "./presentation/output-frame.js";
export {
  recordJourney,
  renderRecordedJourney,
  renderJourney,
  type RecordedJourney,
} from "./storybook/journey-runner.js";
export { journeyFrames, renderReplayFrame, type ReplayFrame } from "./storybook/journey-replay.js";
export {
  STATUS_FRAME_MS,
  CLEAR_STATUS_LINE,
  renderStatusLine,
} from "./presentation/terminal-status.js";
export { journeyStories } from "./storybook/journey-stories.js";
export { OutputStory, outputStories, outputStoryKey } from "./storybook/output-stories.js";
