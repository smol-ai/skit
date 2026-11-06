import { SkitConfiguration, skitConfigurationLayer } from "@smolai/skit-core/platform";
import { Option, Effect } from "effect";
import { Command } from "effect/cli";
import { Renderer } from "../terminal/renderer.js";
import { handleLibraryCommand } from "./handler.js";
import { CommandMetadata } from "./metadata.js";
import { inventoryRootOptions, localFlags } from "./parameters.js";
import { encodeResult as result } from "./encode-result.js";
import { inventoryOutputContracts, inventoryCommand } from "../library/inventory.js";

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

export const inventoryCliCommand = Command.make("inventory", localFlags, (input) =>
  Effect.gen(function* () {
    const paths = yield* SkitConfiguration;

    const selectedHome = paths.skitHome;
    const options = { ...inventoryRootOptions(input, paths), libraryHome: selectedHome };
    return yield* handleLibraryCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const inventory = yield* inventoryCommand(options);
        yield* renderer.result(result("inventory", inventoryOutputContracts.inventory, inventory));
      }),
    );
  }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
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
