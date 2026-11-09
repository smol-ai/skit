import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/cli";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
  jsonFlag,
  JsonOutputFlag,
  jsonRequested,
  skitCliConfigLayer,
} from "../src/commands/parameters.js";

const cases = [
  [],
  ["--json"],
  ["--json=true"],
  ["--json=false"],
  ["--json", "false"],
  ["--json", "true"],
  ["--no-json"],
  ["--json=yes"],
  ["--json=no"],
  ["--json=on"],
  ["--json=off"],
  ["--json=1"],
  ["--json=0"],
  ["--json=y"],
  ["--json=n"],
  ["--name=--json"],
  ["--name", "value", "--json=false"],
  ["--json", "--json"],
  ["--json", "--json=false"],
] as const;

it.effect("early output selection agrees with Effect Boolean grammar", () =>
  Effect.gen(function* () {
    for (const argv of cases) {
      let parsed: boolean | undefined;
      const command = Command.make(
        "probe",
        { json: jsonFlag, name: Flag.String("name").pipe(Flag.optional) },
        (input) =>
          Effect.sync(() => {
            parsed = input.json;
          }),
      ).pipe(Command.withGlobalFlags([JsonOutputFlag]));
      const exit = yield* Command.runWith(command, { version: "test", renderErrors: false })(
        argv,
      ).pipe(Effect.provide(Layer.merge(skitCliConfigLayer, NodeServices.layer)), Effect.exit);
      const repeated = argv.filter((arg) => arg.startsWith("--json")).length > 1;
      expect(exit._tag, JSON.stringify(argv)).toBe(repeated ? "Failure" : "Success");
      if (exit._tag === "Success") expect(jsonRequested(argv)).toBe(parsed);
      else expect(parsed).toBeUndefined();
    }
  }),
);

it("output selection respects operands and flag values", () => {
  expect(jsonRequested(["--", "--json"])).toBe(false);
  expect(jsonRequested(["--name=--json"])).toBe(false);
  expect(jsonRequested(["--json", "--", "--no-json"])).toBe(true);
  // Repeated/malformed flags are validated by Effect. The last recognized setting
  // selects the envelope for the resulting parse error.
  expect(jsonRequested(["--json", "--json=false"])).toBe(false);
  expect(jsonRequested(["--json=false", "--json"])).toBe(true);
});
