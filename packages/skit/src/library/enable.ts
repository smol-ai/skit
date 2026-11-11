/** Enable/disable selection, reviewed plans and application outcomes. */
export { SetEnabledChange, SetEnabledResult } from "./internal/session/set-enabled-contract.js";
export {
  type SetEnabledIntent,
  type EnabledCollection,
  sameInstallScope,
} from "./internal/session/set-enabled-request.js";
export {
  type SetEnabledPlan,
  SetEnabledIncomplete,
  setEnabledOutcomes,
} from "./internal/session/set-enabled.js";

export { ApplyFailure } from "./apply-failure.js";
