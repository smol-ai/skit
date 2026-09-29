import { skillModificationTime } from "../../workflows/library/skill-metadata.js";
import { Effect, FileSystem, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { join, resolve } from "node:path";
import { handleCommand } from "../../application.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags, optionalString } from "../../commands/parameters.js";
import { Prompter, terminalPrompterLayer } from "../../presentation/prompter.js";
import { Renderer } from "../../presentation/renderer.js";
import { renderSetupDiscovery } from "../../presentation/contract-presenters.js";
import {
  readSetupMachineConfig,
  setupRepositoryDecisions,
  revalidateSetupPlan,
  runSetup,
  type SetupOptions,
} from "../../workflows/library/setup.js";
import {
  applySetupLocalCustody,
  type SetupLocalCustodyOptions,
} from "../../workflows/library/setup-local-custody.js";
import type { SetupResult } from "../../workflows/library/setup-contract.js";
import { applySetupExistingBindings } from "../../workflows/library/setup-existing-binding.js";
import { applySetupObservedCollections } from "../../workflows/library/setup-observed-collections.js";
import { result } from "../contracts.js";
import { LibraryStore } from "@smolai/skit-core";
import { checkSubjectsEffect } from "../../workflows/library/check.js";
import { renderCheck } from "../../presentation/check.js";
import { setupDiscoveredSkillChoices } from "../../presentation/setup-skills.js";
import { terminalColors } from "../../presentation/terminal-style.js";
import {
  applySetupRemovals,
  planSetupRemovals,
  setupRemovablePaths,
} from "../../workflows/library/setup-removal.js";

const workDirFlag = optionalString(
  "work-dir",
  "Repository root to remember for this machine and scan.",
);
const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Observe without updating machine configuration."),
  Flag.withDefault(false),
);

/** Show the newest SKILL.md modification time when a row represents multiple copies. */
export const setupSkillModificationHint = Effect.fn("CLI.setup.skillModificationHint")(function* (
  paths: readonly string[],
) {
  const dates = yield* Effect.forEach(paths, skillModificationTime);
  const available = dates.filter((date): date is string => date !== null).sort();
  const latest = available.at(-1);
  const copies =
    paths.length <= 1
      ? ""
      : available.length === paths.length
        ? " (latest copy)"
        : " (latest readable copy)";
  return latest === undefined
    ? "SKILL.md modified: unavailable"
    : `SKILL.md modified ${latest.slice(0, 10)}${copies}`;
});

export const shouldSetupInteractively = (input: {
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly stdin: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
}): boolean => !input.json && !input.dryRun && input.stdin && input.stdout && input.stderr;

export const setupCommand = Effect.fn("CLI.setup")(function* (input: {
  readonly options: Omit<SetupOptions, "repositoryRoots" | "persistRoots">;
  readonly localCustody?: SetupLocalCustodyOptions["adoption"];
  readonly cwd: string;
  readonly interactive: boolean;
  readonly dryRun: boolean;
  readonly workDirFlag?: string;
}) {
  const configured = yield* readSetupMachineConfig(input.options.libraryHome);
  const roots = input.workDirFlag ? [resolve(input.workDirFlag)] : [];
  let persistRoots = Boolean(input.workDirFlag) && !input.dryRun;
  let setupOptions: SetupOptions = {
    ...input.options,
    repositoryRoots: roots,
    persistRoots: !input.interactive && persistRoots,
  };
  const renderer = yield* Renderer;
  const observe = (options: SetupOptions) =>
    renderer.withStatus("Observing local skills", runSetup(options));
  let observed = yield* observe(setupOptions);
  if (!input.interactive || input.dryRun || !input.localCustody) return observed;
  yield* renderer.note(renderSetupDiscovery(observed, terminalColors()), "Local discovery");
  const discoveredRepositories = observed.repositories;
  let repositoryDecisions: ReadonlyArray<{
    path: string;
    status: "watched" | "ignored";
  }> = [];
  if (discoveredRepositories.length) {
    const prompter = yield* Prompter;
    const watched = yield* prompter.multiselect(
      "Select repositories for SKIT to track. Deselect for SKIT to ignore.",
      discoveredRepositories.map((repository) => ({
        value: repository.path,
        label: repository.path,
        hint: `${repository.skills.length} skill${repository.skills.length === 1 ? "" : "s"}`,
        selected: repository.status !== "ignored",
      })),
    );
    const watchedPaths = new Set(watched);
    repositoryDecisions = discoveredRepositories.map((repository) => ({
      path: repository.path,
      status: watchedPaths.has(repository.path) ? ("watched" as const) : ("ignored" as const),
    }));
    setupOptions = {
      ...setupOptions,
      repositoryDecisions,
      scanDecidedRepositories: true,
    };
    const configuredDecisions = new Map(
      setupRepositoryDecisions(configured).map((decision) => [decision.path, decision.status]),
    );
    const decisionsChanged = repositoryDecisions.some(
      (decision) => configuredDecisions.get(decision.path) !== decision.status,
    );
    persistRoots = !input.dryRun && (persistRoots || decisionsChanged);
    observed = yield* observe({ ...setupOptions, persistRoots: false });
  }
  let retainedSourceSelections: ReadonlyArray<{
    name: string;
    paths: readonly string[];
    groupKey: string;
  }> = [];
  let existingBindingSelections: readonly { name: string; path: string }[] = [];
  let localCustodySelections: ReadonlyArray<{
    name: string;
    sourcePath: string;
  }> = [];
  const installedSelections = yield* chooseDiscoveredSkills(setupOptions, observed);
  retainedSourceSelections = installedSelections.import;
  existingBindingSelections = installedSelections.bind;
  localCustodySelections = installedSelections.add;
  const removalPlan = yield* planSetupRemovals(
    setupOptions,
    observed,
    installedSelections.remove,
    installedSelections.removablePaths,
  );
  const prompter = yield* Prompter;
  const hasChanges =
    persistRoots ||
    retainedSourceSelections.length > 0 ||
    existingBindingSelections.length > 0 ||
    localCustodySelections.length > 0 ||
    removalPlan.entries.length > 0;
  if (!hasChanges) {
    yield* renderer.note(
      "Nothing was selected and the repository roots are unchanged.",
      "No setup changes",
    );
    yield* offerSkillsShUpdateCheck();
    return observed;
  }
  const retainedBySource = [
    ...new Map(
      observed.onboarding.candidates.flatMap((candidate) =>
        candidate.action === "import-observed-collection" &&
        retainedSourceSelections.some(
          (selection) =>
            selection.groupKey === candidate.groupKey &&
            selection.name === candidate.name &&
            selection.paths.every((path) => candidate.paths.includes(path)),
        )
          ? [[candidate.groupKey, candidate] as const]
          : [],
      ),
    ).values(),
  ].map((source) => {
    const names = observed.onboarding.candidates
      .filter(
        (candidate) =>
          candidate.action === "import-observed-collection" &&
          candidate.groupKey === source.groupKey &&
          retainedSourceSelections.some(
            (selection) =>
              selection.groupKey === candidate.groupKey &&
              selection.name === candidate.name &&
              selection.paths.every((path) => candidate.paths.includes(path)),
          ),
      )
      .map((candidate) => candidate.name)
      .sort();
    return { source, names };
  });
  const repositorySelections = localCustodySelections.filter((selection) =>
    observed.instances.some(
      (instance) =>
        instance.path === selection.sourcePath &&
        (instance.git.repository !== undefined ||
          instance.scope !== "global" ||
          instance.harnesses.length === 0),
    ),
  );
  const custodySelections = localCustodySelections.filter(
    (selection) => !repositorySelections.includes(selection),
  );
  const planLines = [
    ...(persistRoots ? [`Save discovery roots: ${roots.join(", ")}`] : []),
    ...repositoryDecisions.map(
      (decision) =>
        `${decision.status === "watched" ? "Watch" : "Ignore"} repository: ${decision.path}`,
    ),
    ...(retainedSourceSelections.length && !observed.machineConfig.machineId
      ? ["Create this machine's stable Library identity"]
      : []),
    ...(retainedBySource.length
      ? [
          `Import installed skills.sh Collections into the SKIT Library: ${retainedBySource.length}`,
          ...retainedBySource.flatMap(({ source, names }) => [
            `  ${source.source} · observed lock ${source.lockContentHash.slice(0, 14)} · ${names.length} skill${names.length === 1 ? "" : "s"}`,
            ...(names.length <= 5 ? [`    ${names.join(", ")}`] : []),
          ]),
        ]
      : []),
    ...(existingBindingSelections.length
      ? [
          `Reconnect existing Library matches: ${existingBindingSelections.length}`,
          ...existingBindingSelections.map(({ name, path }) => `  ${name} · ${path}`),
        ]
      : []),
    ...(localCustodySelections.length
      ? [
          `Add to Library: ${localCustodySelections.length}`,
          ...localCustodySelections.map(
            (selection) => `  ${selection.name} · ${selection.sourcePath ?? "observed copy"}`,
          ),
        ]
      : []),
    ...(custodySelections.length ? [`Take custody: ${custodySelections.length}`] : []),
    ...localCustodySelections.flatMap((selection) => {
      const candidate = observed.onboarding.candidates.find((item) =>
        item.paths.includes(selection.sourcePath ?? ""),
      );
      return candidate?.action === "blocked" && candidate.reason === "divergent-copies"
        ? [
            `Authoritative copy: ${selection.name} · ${selection.sourcePath}`,
            "  Other copies stay in place unless explicitly marked Remove.",
          ]
        : [];
    }),
    ...(removalPlan.entries.length
      ? [
          `Remove installed copies: ${removalPlan.entries.length}`,
          ...removalPlan.entries.map(
            (entry) =>
              `  ${entry.name} · ${entry.path}${entry.type === "SymbolicLink" ? " (symlink only; source stays)" : " (move directory to recovery)"}`,
          ),
          `Recovery folder: ${removalPlan.recoveryDirectory}`,
          "Library entries and source files outside these locations stay in place.",
        ]
      : []),
    ...(repositorySelections.length
      ? [
          "Repository copies stay in place. To transfer custody later, remove the repository copy and run `skit enable`.",
        ]
      : []),
  ];
  yield* renderer.note(planLines.join("\n"), "Setup plan");
  const approved = yield* prompter.confirm("Apply this setup plan?");
  if (!approved) {
    yield* renderer.note("No changes were applied.", "Setup cancelled");
    return observed;
  }
  observed = yield* renderer.withStatus(
    "Revalidating the approved setup plan",
    revalidateSetupPlan(setupOptions, observed.onboarding.planId),
  );
  if (removalPlan.entries.length) {
    yield* renderer.withStatus(
      `Removing ${removalPlan.entries.length} installed cop${removalPlan.entries.length === 1 ? "y" : "ies"}`,
      applySetupRemovals(removalPlan),
    );
    yield* renderer.note(
      `Removed installed locations are saved at ${removalPlan.recoveryDirectory}. Move each entry back to its original path recorded in receipt.json to restore it.`,
      "Removed copies saved",
    );
  }
  if (
    (retainedSourceSelections.length || localCustodySelections.length) &&
    !observed.machineConfig.machineId
  )
    observed = yield* renderer.withStatus(
      "Creating this machine's Library identity",
      runSetup({ ...setupOptions, persistRoots: true }),
    );
  if (retainedSourceSelections.length) {
    const retainedSkillCount = retainedBySource.reduce(
      (count, item) => count + item.names.length,
      0,
    );
    yield* renderer.withStatus(
      `Importing ${retainedBySource.length} installed Collection${retainedBySource.length === 1 ? "" : "s"} (${retainedSkillCount} Skill${retainedSkillCount === 1 ? "" : "s"})`,
      applySetupObservedCollections(
        { setup: setupOptions, retention: input.localCustody.acquisition },
        observed,
        retainedSourceSelections,
      ),
    );
  }
  if (existingBindingSelections.length) {
    observed = yield* observe(setupOptions);
    yield* renderer.withStatus(
      `Reconnecting ${existingBindingSelections.length} existing Library match${existingBindingSelections.length === 1 ? "" : "es"}`,
      applySetupExistingBindings(
        { setup: setupOptions, bindings: input.localCustody.bindings },
        observed.onboarding.planId,
        existingBindingSelections,
      ),
    );
  }
  if (localCustodySelections.length) {
    observed = yield* observe(setupOptions);
    const names = localCustodySelections.map((selection) => selection.name).join(", ");
    yield* renderer.withStatus(
      `Taking custody of ${localCustodySelections.length} local Skill${localCustodySelections.length === 1 ? "" : "s"}: ${names}`,
      applySetupLocalCustody(
        { setup: setupOptions, adoption: input.localCustody },
        observed.onboarding.planId,
        localCustodySelections,
      ),
    );
  }
  if (
    retainedSourceSelections.length &&
    !persistRoots &&
    !existingBindingSelections.length &&
    !localCustodySelections.length &&
    !removalPlan.entries.length
  ) {
    // The import checked the staged bytes and the saved Library Versions. Interactive setup does
    // not render this pre-apply observation, so a global rescan adds no user-visible result.
    yield* renderer.note("Selected setup changes were applied.", "Setup complete");
    yield* offerSkillsShUpdateCheck();
    return observed;
  }
  const refreshed = yield* renderer.withStatus(
    "Verifying the completed setup",
    runSetup({ ...setupOptions, persistRoots }),
  );
  yield* renderer.note("Selected setup changes were applied.", "Setup complete");
  yield* offerSkillsShUpdateCheck();
  return refreshed;
});

const offerSkillsShUpdateCheck = Effect.fn("CLI.setup.offerSkillsShUpdateCheck")(function* () {
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const collectionIds = [
    ...new Set(
      state.acquisitions
        .filter((acquisition) =>
          acquisition.observations.some((observation) => observation.type === "skills.sh-lock"),
        )
        .map((acquisition) => acquisition.collection_id),
    ),
  ];
  if (!collectionIds.length) return;
  const prompter = yield* Prompter;
  if (
    !(yield* prompter.confirm(
      `Check ${collectionIds.length} retained skills.sh Source${collectionIds.length === 1 ? "" : "s"} for updates now?`,
    ))
  )
    return;
  const renderer = yield* Renderer;
  const checks = yield* renderer.withStatus(
    "Checking retained skills.sh Sources",
    Effect.flatMap(
      Effect.forEach(collectionIds, (collectionId) => checkSubjectsEffect(state, collectionId)),
      (results) => Effect.succeed(results.flat()),
    ),
  );
  yield* renderer.note(renderCheck(checks), "Source updates");
});

const chooseDiscoveredSkills = Effect.fn("CLI.setup.chooseDiscoveredSkills")(function* (
  options: SetupOptions,
  observed: SetupResult,
) {
  const removablePaths = yield* setupRemovablePaths(options, observed);
  const prompter = yield* Prompter;
  const fs = yield* FileSystem.FileSystem;
  const rows = setupDiscoveredSkillChoices(
    observed.instances,
    observed.onboarding.candidates,
    options.inventory.home,
  );
  const choices = yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const modified = yield* setupSkillModificationHint([row.instance.path]);
      const path = join(row.instance.path, "SKILL.md");
      return {
        ...row.choice,
        ...((removablePaths.get(row.instance.path)?.length ?? 0) > 0
          ? { removeValue: `remove\0${row.choice.value}` }
          : {}),
        hint: `${row.choice.hint} · ${modified}`,
        preview: () =>
          fs.readFileString(path).pipe(
            Effect.map(
              (content) =>
                `${path}\n\n${content.length > 65_536 ? `${content.slice(0, 65_536)}\n\n[Preview truncated at 65,536 characters]` : content}`,
            ),
            Effect.orElseSucceed(
              () => `${path}\n\nContent unavailable: the file could not be read.`,
            ),
          ),
      };
    }),
  );
  const selectedValues = choices.length
    ? yield* prompter
        .multiselect("Manage discovered skills: choose a copy to add, or mark Remove", choices)
        .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed([])))
    : [];
  const selectedRows = rows.filter((row) => selectedValues.includes(row.choice.value));
  const add = selectedRows.flatMap(({ instance, candidate, choice }) =>
    !choice.disabled &&
    candidate &&
    candidate.action !== "import-observed-collection" &&
    candidate.action !== "bind-existing-entry"
      ? [{ name: instance.name, sourcePath: instance.path }]
      : [],
  );
  const imported = selectedRows.flatMap(({ instance, candidate }) =>
    candidate?.action === "import-observed-collection"
      ? [{ name: candidate.name, paths: [instance.path], groupKey: candidate.groupKey }]
      : [],
  );
  const bind = selectedRows.flatMap(({ instance, candidate }) =>
    candidate?.action === "bind-existing-entry"
      ? [{ name: candidate.name, path: instance.path }]
      : [],
  );
  const remove = rows
    .filter((row) => selectedValues.includes(`remove\0${row.choice.value}`))
    .map(({ instance }) => ({ name: instance.name, paths: [instance.path] }));
  return { add, import: imported, bind, remove, removablePaths };
});

export const setupCliCommand = Command.make(
  "setup",
  { workDir: workDirFlag, dryRun, ...localFlags },
  (input) => {
    const selectedHome = homePath(input.home);
    const interactive = shouldSetupInteractively({
      json: input.json,
      dryRun: input.dryRun,
      stdin: Boolean(process.stdin.isTTY),
      stdout: Boolean(process.stdout.isTTY),
      stderr: Boolean(process.stderr.isTTY),
    });
    return handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const configuration = yield* libraryCommandConfiguration(input);
        const value = yield* setupCommand({
          workDirFlag: Option.getOrUndefined(input.workDir),
          cwd: resolve(process.cwd()),
          interactive,
          dryRun: input.dryRun || input.json,
          options: {
            libraryHome: selectedHome,
            inventory: configuration.inventory,
            probePath: process.env.PATH,
            skillsStateHome: process.env.XDG_STATE_HOME,
          },
          localCustody: {
            acquisition: configuration.acquisition,
            bindings: configuration.pull.bindings,
          },
        });
        if (!interactive) yield* renderer.result(result("setup", outputContracts.setup, value));
      }).pipe(Effect.provide(terminalPrompterLayer)),
      selectedHome,
    );
  },
).pipe(
  Command.withDescription(
    "Remember this machine's repository roots and explain existing Skill Instances.",
  ),
  Command.withExamples([
    { command: "skit setup" },
    { command: "skit setup --work-dir ~/Work" },
    { command: "skit setup --dry-run --json --work-dir ~/Work" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "network.write", "process.execute"],
      subprocesses: [
        "git ls-files",
        "git status --porcelain",
        "git clone --mirror",
        "git fetch --all --prune",
        "git rev-parse",
        "git ls-tree",
        "git cat-file blob",
        "git log",
        "codex --version",
        "claude --version",
        "opencode --version",
        "devin --version",
      ],
    },
    outputSchemas: [outputContracts.setup],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: true,
  }),
);
