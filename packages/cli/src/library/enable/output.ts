import { SetEnabledChange, SetEnabledResult } from "@smolai/skit-core/library/session";

export const enableOutputContracts = {
  enable: { id: "skit.enable.v10", schema: SetEnabledResult },
  enablePlan: { id: "skit.enable.plan.v9", schema: SetEnabledChange },
  disable: { id: "skit.disable.v10", schema: SetEnabledResult },
  disablePlan: { id: "skit.disable.plan.v9", schema: SetEnabledChange },
} as const;
