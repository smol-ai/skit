import { validateSkitDirectory } from "@smolai/skit-core/author";
import { Effect } from "effect";
import { resolve } from "node:path";

import { type ContractDataForId } from "../commands/output-contracts.js";

export const validateCommand = Effect.fn("CLI.validate")(function* (
  input: string,
  assessmentContext: "author" | "publish",
) {
  const value = yield* validateSkitDirectory(resolve(input), "unpublished", {
    assessmentContext,
  });
  const structurallyValid = !value.diagnostics.some(
    (item) => item.severity === "error" && item.code !== "SECURITY_POLICY_BLOCKED",
  );
  const status: ContractDataForId<"skit.validate.v3">["status"] = (() => {
    if (!structurallyValid) return "invalid";
    if (value.diagnostics.some((item) => item.code === "SECURITY_POLICY_BLOCKED"))
      return "policy-blocked";
    return value.diagnostics.length ? "valid-with-warnings" : "valid";
  })();
  return { value, status };
});
