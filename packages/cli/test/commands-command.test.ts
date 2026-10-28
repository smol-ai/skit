import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { commandApplicationLayer } from "../src/application.js";
import { commandDescriptions } from "../src/commands/manifest.js";
import { skitCommand } from "../src/commands/tree.js";

it.effect("derives public command metadata from the executable tree", () =>
  commandDescriptions(skitCommand).pipe(
    Effect.map((commands) => {
      assert.ok(commands.some((command) => command.path.join(" ") === "registry add"));
      assert.ok(commands.some((command) => command.path.join(" ") === "registry list"));
      const inventory = commands.find((command) => command.path.join(" ") === "inventory");
      assert.ok(inventory);
      assert.deepStrictEqual(inventory.successExitCodes, [0, 12, 64, 65]);
      assert.ok(inventory.outputSchemas.includes("skit.inventory.v12"));
      assert.ok(inventory.outputSchemas.includes("skit.error.v1"));
    }),
    Effect.provide(commandApplicationLayer(false, "/tmp/skit-commands-command-test")),
  ),
);

// The manifest is read from help documents; they must use the grammar the CLI executes with.
it.effect("publishes only flags the executing parser accepts", () =>
  commandDescriptions(skitCommand).pipe(
    Effect.map((commands) => {
      const withWizard = commands
        .filter((command) => Object.hasOwn(command.flags, "wizard"))
        .map((command) => command.path.join(" "));
      assert.deepStrictEqual(withWizard, []);
    }),
    Effect.provide(commandApplicationLayer(false, "/tmp/skit-commands-flags-test")),
  ),
);
