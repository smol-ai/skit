import { Effect } from "effect";
import { Command } from "effect/cli";
import { Renderer } from "../terminal/renderer.js";

import { CommandMetadata } from "./metadata.js";
import { localFlags } from "./parameters.js";
import { encodeResult as result } from "./encode-result.js";
import { inventoryOutputContracts } from "../library/inventory/output.js";
import * as Library from "@smolai/skit-core/library";

const machineInventoryMetadata = {
  effects: {
    capabilities: ["filesystem.read", "filesystem.write", "process.execute"],
    subprocesses: [
      "git ls-files",
      "git status --porcelain",
      "codex --version",
      "claude --version",
      "opencode --version",
      "devin --version",
    ],
  },
  exitCodes: [0, 12, 64, 65],
  interactive: false,
} as const;

export const inventoryCliCommand = Command.make("inventory", localFlags, () =>
  Effect.gen(function* () {
    const renderer = yield* Renderer;
    const library = yield* Library.Service;
    const inventory = yield* renderer.withStatus(
      "Scanning repository and harness skills",
      library.inventory.refreshMachine,
    );
    yield* renderer.result(result("inventory", inventoryOutputContracts.inventory, inventory));
  }),
).pipe(
  Command.withDescription(
    "Show every Skill folder found on this machine, its Git state, and refreshed installed skills.",
  ),
  Command.withExamples([{ command: "skit inventory --json" }]),
  Command.annotate(CommandMetadata, {
    ...machineInventoryMetadata,
    outputSchemas: [inventoryOutputContracts.inventory],
  }),
);
