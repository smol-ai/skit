import { UsageReport } from "@smolai/skit-core/library/usage";

export const usageOutputContracts = {
  usage: { id: "skit.usage.v4", schema: UsageReport },
} as const;
