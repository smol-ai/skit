import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { duplicatesFlag } from "../src/library/setup/duplicate-options.js";
import { cliLayer } from "../src/application.js";
import { commandDocuments } from "../src/commands/manifest.js";
import { skitCommand } from "../src/commands/tree.js";

it.effect.each([
  ["import-only", "retain-only"],
  ["keep-both", "keep-both"],
  ["back-up-symlinks", "retire-aliases"],
  ["back-up-copies", "preserve-duplicates"],
] as const)("parses duplicate option %j", ([input, expected]) =>
  Effect.gen(function* () {
    let parsed: string | undefined;
    const command = Command.make("setup", { duplicates: duplicatesFlag }, ({ duplicates }) =>
      Effect.sync(() => {
        parsed = duplicates;
      }),
    );
    yield* Command.runWith(command, { version: "test" })(["--duplicates", input]);
    expect(parsed).toBe(expected);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("documents the executable duplicate choices and their filesystem effects", () =>
  Effect.gen(function* () {
    const setup = (yield* commandDocuments(skitCommand)).find(
      (item) => item.path.join(" ") === "setup",
    );
    expect(setup).toBeDefined();
    const flag = setup!.documentedFlags.duplicates!;
    for (const name of ["import-only", "keep-both", "back-up-symlinks", "back-up-copies"])
      expect(flag.description).toContain(name);
    expect(flag.description).toContain("imports without enabling");
    expect(flag.description).toContain("identical global copies into recovery");
  }).pipe(Effect.provide(cliLayer(false, "/tmp/skit-duplicate-options-test"))),
);
