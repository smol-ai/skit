import { Effect } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { outputContracts } from "../src/commands/output-contracts.js";
import { result } from "../src/handlers/contracts.js";
import {
  defaultTerminalEnvironment,
  renderFailureFrame,
  renderResultFrame,
} from "../src/presentation/output-frame.js";

describe("terminal output frames", () => {
  it.effect("renders human and JSON output from the same command result", () =>
    Effect.sync(() => {
      const commandResult = result("version", outputContracts.version, { version: "1.2.3" });
      expect(renderResultFrame(commandResult, defaultTerminalEnvironment)).toEqual({
        stdout: "1.2.3\n",
        stderr: "",
        exitCode: undefined,
      });
      expect(
        renderResultFrame(commandResult, { ...defaultTerminalEnvironment, format: "json" }),
      ).toEqual({
        stdout: '{\n  "schema": "skit.version.v1",\n  "data": {\n    "version": "1.2.3"\n  }\n}\n',
        stderr: "",
        exitCode: undefined,
      });
    }),
  );

  it.effect("keeps failures on stderr with their semantic exit code", () =>
    Effect.sync(() => {
      expect(
        renderFailureFrame(
          {
            code: "CONFLICT",
            exitCode: 12,
            message: "Projection failed",
            remediation: "Run doctor",
          },
          "human",
        ),
      ).toEqual({
        stdout: "",
        stderr: "Error: Projection failed\nNext: Run doctor\n",
        exitCode: 12,
      });
    }),
  );
});
