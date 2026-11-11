import { SetEnabledChange, SetEnabledResult } from "@smolai/skit-core/library/enable";

import { Schema } from "effect";

export const enableOutputContracts = {
  enable: {
    id: "skit.enable.v8",
    schema: SetEnabledResult.pipe(Schema.fieldsAssign({ action: Schema.Literal("enable") })),
  },
  enablePlan: {
    id: "skit.enable.plan.v8",
    schema: SetEnabledChange.pipe(Schema.fieldsAssign({ action: Schema.Literal("enable") })),
  },
  disable: {
    id: "skit.disable.v8",
    schema: SetEnabledResult.pipe(Schema.fieldsAssign({ action: Schema.Literal("disable") })),
  },
  disablePlan: {
    id: "skit.disable.plan.v8",
    schema: SetEnabledChange.pipe(Schema.fieldsAssign({ action: Schema.Literal("disable") })),
  },
} as const;
