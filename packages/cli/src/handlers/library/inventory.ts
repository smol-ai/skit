import {
  SkitConfiguration,
  skitConfigurationLayer,
} from "../../configuration/skit-configuration.js";
import { skillUsageLayer, withLibraryWriter } from "@smolai/skit-core";
import { skillModificationTime } from "../../library-application/skill-metadata.js";
import { Option, Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { terminalPrompterLayer } from "../../presentation/prompter.js";
import { presentDoctorCleanup } from "../../workflows/library/doctor-cleanup.js";
import {
  libraryDoctorReport,
  LibraryStore,
  refreshLibraryInventory,
  pathIsWithin,
  type LibraryState,
} from "@smolai/skit-core";
import { selectInventoryRoots, type InventoryRootOptions } from "../../projection/roots.js";
import { Renderer } from "../../presentation/renderer.js";
import { handleLibraryCommand } from "../../application.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { inventoryRootOptions, localFlags } from "../../commands/parameters.js";
import { result } from "../contracts.js";
import { runSetup } from "../../workflows/library/setup.js";
import { inspectNativeDiscovery } from "../../workflows/library/doctor-harnesses.js";
import { promptsAllowed } from "../../presentation/interactivity.js";

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
}, withLibraryWriter);

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
      instances: yield* Effect.forEach(
        observed.instances,
        (instance) =>
          skillModificationTime(instance.path).pipe(
            Effect.map((modified) => ({
              ...instance,
              skill_md_modified_at: modified,
            })),
          ),
        { concurrency: 8 },
      ),
      brokenLinks: observed.brokenLinks,
      suppressed: observed.suppressed,
    },
  };
});

/** Diagnose the same freshly persisted observation; report construction is pure. */
export const doctorCommand = Effect.fn("CLI.doctor")(function* (options: CliInventoryOptions) {
  const inventory = yield* refreshLibraryInventoryCommand(options);
  const report = libraryDoctorReport(inventory);
  const renderer = yield* Renderer;
  const native = yield* renderer.withStatus(
    "Checking native harness skill discovery",
    inspectNativeDiscovery(inventory, { ...options, cwd: process.cwd() }),
  );
  return { ...report, ...native };
});

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
        const value = yield* inventoryCommand(options);
        const {
          schemaVersion: _schemaVersion,
          sync_ancestry: _syncAncestry,
          assessmentAcceptances: _,
          collections: __,
          global_bindings: ___,
          local_bindings: ____,
          ...inventory
        } = value;
        yield* renderer.result(result("inventory", inventory));
      }),
    );
  }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
).pipe(
  Command.withDescription(
    "Show every observed Skill instance, its Git state, and refreshed Library projections.",
  ),
  Command.withExamples([{ command: "skit inventory --json" }]),
  Command.annotate(CommandMetadata, {
    ...machineInventoryMetadata,
    outputSchemas: [outputContracts.inventory],
  }),
);

export const doctorCliCommand = Command.make(
  "doctor",
  {
    ...localFlags,
    days: Flag.Int("days").pipe(
      Flag.filter(
        (days) => days >= 1 && days <= 3650,
        () => "Days must be between 1 and 3650.",
      ),
      Flag.withDefault(14),
      Flag.withDescription("Review this many rolling days of local skill activity (1–3650)."),
    ),
    reportOnly: Flag.Boolean("report-only").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Show diagnostics without interactive skill cleanup."),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Preview interactive cleanup without disabling skills."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      const options = { ...inventoryRootOptions(input, paths), libraryHome: selectedHome };
      return yield* handleLibraryCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const value = yield* doctorCommand(options);
          yield* renderer.result(result("doctor", value, value.ok ? undefined : 12));
          if (!input.reportOnly && promptsAllowed({ json: input.json })) {
            const changed = yield* presentDoctorCleanup(
              value.listing_budgets,
              options,
              input.days,
              input.dryRun,
            ).pipe(
              Effect.provide(skillUsageLayer),
              Effect.catchTag("PromptCancelled", () => Effect.succeed(false)),
            );
            if (changed) {
              const checked = yield* doctorCommand(options);
              yield* renderer.result(result("doctor", checked, checked.ok ? 0 : 12));
            }
          }
        }).pipe(Effect.provide(terminalPrompterLayer)),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
).pipe(
  Command.withDescription(
    "Diagnose local skills and interactively review over-budget skill context.",
  ),
  Command.withExamples([{ command: "skit doctor" }]),
  Command.annotate(CommandMetadata, {
    interactive: true,
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "process.execute"],
      subprocesses: [
        "codex --version",
        "codex app-server",
        "claude --version",
        "claude --print --input-format stream-json --output-format stream-json",
        "opencode --version",
        "node (bounded OpenCode capture)",
        "opencode debug skill",
        "devin --version",
        "devin skills list --json",
      ],
    },
    outputSchemas: [outputContracts.doctor, outputContracts.disablePlan, outputContracts.disable],
    exitCodes: [0, 11, 12, 64, 65],
  }),
);
