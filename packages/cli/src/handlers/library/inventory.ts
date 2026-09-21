import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import {
  libraryDoctorReport,
  LibraryStore,
  refreshLibraryInventory,
  pathIsWithin,
  type LibraryState,
} from "@smolai/skit-core";
import { selectInventoryRoots, type InventoryRootOptions } from "../../projection/roots.js";
import { Renderer } from "../../presentation/renderer.js";
import { handleCommand } from "../../application.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, inventoryRootOptions, localFlags } from "../../commands/parameters.js";
import { result } from "../contracts.js";
import { runSetup } from "../../workflows/library/setup.js";

export type CliInventoryOptions = InventoryRootOptions & { readonly libraryHome: string };

export const refreshLibraryInventoryForCli = Effect.fn("CLI.refreshLibraryInventory")(function* (
  options: CliInventoryOptions,
  loaded: LibraryState,
) {
  const { state, roots } = yield* refreshLibraryInventory(loaded, (state) =>
    selectInventoryRoots(state, options),
  );
  return {
    ...state,
    unmanaged: state.unmanaged.filter((item) =>
      roots.some(({ root }) => pathIsWithin(root, item.path)),
    ),
    custodyIssues: (state.custodyIssues ?? []).filter((item) =>
      roots.some(({ root }) => pathIsWithin(root, item.path)),
    ),
    ...(state.scanIssues
      ? {
          scanIssues: state.scanIssues.filter((item) =>
            roots.some(({ root }) => pathIsWithin(root, item.path)),
          ),
        }
      : {}),
  };
});

/**
 * The reference CLI workflow: application services enter through the environment, the complete
 * operation stays on the root fiber, and its exact domain failures reach the application boundary.
 */
const refreshLibraryInventoryCommand = Effect.fn("CLI.refreshLibraryInventory")(function* (
  options: CliInventoryOptions,
) {
  const renderer = yield* Renderer;
  const store = yield* LibraryStore;
  const before = yield* store.load;
  const after = yield* renderer.withStatus(
    "Scanning harness installations",
    refreshLibraryInventoryForCli(options, before),
  );
  return after;
});

export const inventoryCommand = Effect.fn("CLI.inventory")(function* (
  options: CliInventoryOptions,
) {
  const library = yield* refreshLibraryInventoryCommand(options);
  const renderer = yield* Renderer;
  const observed = yield* renderer.withStatus(
    "Scanning repository and harness skills",
    runSetup({
      libraryHome: options.libraryHome,
      inventory: options,
      persistRoots: false,
      scanDecidedRepositories: true,
    }),
  );
  return {
    ...library,
    machine: {
      repositoryRoots: observed.machineConfig.repositoryRoots,
      repositoryDecisions: observed.machineConfig.repositoryDecisions,
      scan: observed.scan,
      instances: observed.instances,
      brokenLinks: observed.brokenLinks,
      suppressed: observed.suppressed,
    },
  };
});

/** Diagnose the same freshly persisted observation; report construction is pure. */
export const doctorCommand = Effect.fn("CLI.doctor")(function* (options: CliInventoryOptions) {
  const inventory = yield* refreshLibraryInventoryCommand(options);
  return libraryDoctorReport(inventory);
});

const localInventoryMetadata = {
  effects: { capabilities: ["filesystem.read", "filesystem.write"] },
  exitCodes: [0, 65],
  interactive: false,
} as const;

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
  exitCodes: [0, 65],
  interactive: false,
} as const;

export const inventoryCliCommand = Command.make("inventory", localFlags, (input) => {
  const selectedHome = homePath(input.home);
  const options = { ...inventoryRootOptions(input), libraryHome: selectedHome };
  return handleCommand(
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const value = yield* inventoryCommand(options);
      const {
        assessmentAcceptances: _,
        collections: __,
        global_bindings: ___,
        local_bindings: ____,
        ...inventory
      } = value;
      yield* renderer.result(result("inventory", outputContracts.inventory, inventory));
    }),
    selectedHome,
  );
}).pipe(
  Command.withDescription(
    "Show every observed Skill instance, its Git state, and refreshed Library projections.",
  ),
  Command.withExamples([{ command: "skit inventory --json" }]),
  Command.annotate(CommandMetadata, {
    ...machineInventoryMetadata,
    outputSchemas: [outputContracts.inventory],
  }),
);

export const doctorCliCommand = Command.make("doctor", localFlags, (input) => {
  const selectedHome = homePath(input.home);
  const options = { ...inventoryRootOptions(input), libraryHome: selectedHome };
  return handleCommand(
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const value = yield* doctorCommand(options);
      yield* renderer.result(
        result("doctor", outputContracts.doctor, value, value.ok ? undefined : 12),
      );
    }),
    selectedHome,
  );
}).pipe(
  Command.withDescription("Diagnose local library and projection state."),
  Command.withExamples([{ command: "skit doctor" }]),
  Command.annotate(CommandMetadata, {
    ...localInventoryMetadata,
    outputSchemas: [outputContracts.doctor],
    exitCodes: [0, 12, 65],
  }),
);
