import { expect, test } from "vitest";
import { AuditReportV1Alpha4 } from "@smolai/skit-core/audit";
import { outputContracts } from "../src/commands/output-contracts.js";

test("the CLI publishes the shared versioned audit schema", () => {
  expect(outputContracts.experimentalAuditV1Alpha4.schema).toBe(AuditReportV1Alpha4);
});
