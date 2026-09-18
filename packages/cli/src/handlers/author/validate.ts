import { validateSkitDirectoryEffect } from "@smolai/skit-core";
import { Effect, Option } from "effect";
import { resolve } from "node:path";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { handleCommand } from "../../application.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import type { ContractDataForId } from "../../commands/output-contracts.js";
import { jsonFlag } from "../../commands/parameters.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";

export const validateCommand = Effect.fn("CLI.validate")(function* (
  input: string,
  assessmentContext: "author" | "publish",
) {
  const value = yield* validateSkitDirectoryEffect(resolve(input), "draft", {
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

const path = Argument.string("path").pipe(Argument.optional);
const assessmentContext = Flag.choice("assessment-context", ["author", "publish"] as const).pipe(
  Flag.withDescription(
    "Evaluate authoring warnings or strict publication policy (default: author).",
  ),
  Flag.withDefault("author" as const),
);

export const validateCliCommand = Command.make(
  "validate",
  { path, assessmentContext, json: jsonFlag },
  ({ path, assessmentContext }) =>
    handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const { status, value } = yield* validateCommand(
          Option.getOrElse(path, () => "."),
          assessmentContext,
        );
        yield* renderer.result(
          result(
            "validate",
            outputContracts.validate,
            { valid: status !== "invalid", status, ...value },
            status === "invalid" ? 65 : status === "policy-blocked" ? 77 : undefined,
          ),
        );
      }),
    ),
).pipe(
  Command.withDescription("Validate a SKIT directory and its static audit."),
  Command.withExamples([
    { command: "skit author validate" },
    { command: "skit author validate ./my-tools --json" },
    { command: "skit author validate ./my-tools --assessment-context publish" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.validate],
    exitCodes: [0, 12, 64, 65, 77],
    interactive: false,
  }),
);
