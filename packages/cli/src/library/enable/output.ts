import { SetEnabledChange, SetEnabledResult } from "@smolai/skit-core/library/enable";

export const enableOutputContracts = {
  enable: { id: "skit.enable.v8", schema: SetEnabledResult },
  enablePlan: { id: "skit.enable.plan.v8", schema: SetEnabledChange },
  disable: { id: "skit.disable.v8", schema: SetEnabledResult },
  disablePlan: { id: "skit.disable.plan.v8", schema: SetEnabledChange },
} as const;
