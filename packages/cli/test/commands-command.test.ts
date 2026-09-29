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
      assert.deepStrictEqual(inventory.successExitCodes, [0, 65]);
      assert.ok(inventory.outputSchemas.includes("skit.inventory.v6"));
      assert.ok(inventory.outputSchemas.includes("skit.error.v1"));
    }),
    Effect.provide(commandApplicationLayer(false, "/tmp/skit-commands-command-test")),
  ),
);
