import { expect, test } from "vitest";
import { AuditReportV1Alpha4 } from "@smolai/skit-core/audit";
import { outputContracts } from "../src/commands/output-contracts.js";

test("the audit presenter uses the shared versioned schema", () => {
  expect(outputContracts.experimentalAuditV1Alpha4.schema).toBe(AuditReportV1Alpha4);
});
