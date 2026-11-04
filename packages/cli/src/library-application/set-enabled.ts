import { Effect } from "effect";
import { SkitConfiguration } from "@smolai/skit-core";
import * as Session from "@smolai/skit-core/library/session";
export {
  type SetEnabledConfiguration,
  type SetEnabledPlan,
  SetEnabledStale,
  SetEnabledIncomplete,
  type SetEnabledSession,
} from "@smolai/skit-core/library/session";
export const openSetEnabledSession = (configuration: Session.SetEnabledConfiguration) =>
  Effect.flatMap(SkitConfiguration, (paths) =>
    Session.openSetEnabledSession(paths.skitHome, configuration),
  );
export const planSetEnabled = (
  requests: readonly Session.SetEnabledRequest[],
  configuration: Session.SetEnabledConfiguration,
) =>
  Effect.flatMap(SkitConfiguration, (paths) =>
    Session.planSetEnabled(paths.skitHome, requests, configuration),
  );

export type {
  SetEnabledIntent,
  SetEnabledRequest,
  EnabledCollection,
} from "@smolai/skit-core/library/session";

export const applySetEnabledPlan = (plan: Session.SetEnabledPlan) =>
  Effect.flatMap(SkitConfiguration, (paths) => Session.applySetEnabledPlan(paths.skitHome, plan));
