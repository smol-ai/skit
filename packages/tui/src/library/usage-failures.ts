import { InvalidUsageOptions, InvalidUsageReason } from "@smolai/skit-core/library/usage/contracts";
import { errorMessage } from "@smolai/skit-core/shared";

export const usageFailure = ({ reason }: InvalidUsageOptions) => ({
  message: InvalidUsageReason.match(reason, {
    InvalidEnd: ({ end }) => `Invalid usage end timestamp: ${end}`,
    InvalidDays: ({ days }) =>
      `Usage days must be a whole number between 1 and 3650; received ${days}`,
    DateRangeExceeded: () =>
      "Both usage window boundaries must be within the supported date range.",
    ProjectUnreadable: ({ path, failure }) =>
      `Cannot read directory ${path}: ${errorMessage(failure)}`,
    ProjectNotDirectory: ({ path, kind }) =>
      `Path ${path} is a ${kind.toLowerCase()}, not a directory`,
  }),
  remediation: "Review the usage date range and directory, then retry.",
});
