import { UsageReport } from "@smolai/skit-core";

export const usageOutputContracts = {
  usage: { id: "skit.usage.v4", schema: UsageReport },
} as const;
