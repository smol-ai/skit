import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import pc from "picocolors";
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
  isSetupCandidateSelectedByDefault,
  type SetupOptions,
} from "../../workflows/library/setup.js";
import {
  applySetupLocalCustody,
  type SetupLocalCustodyOptions,
} from "../../workflows/library/setup-local-custody.js";
import type { SetupInstanceOwner, SetupResult } from "../../workflows/library/setup-contract.js";
import { applySetupExistingBindings } from "../../workflows/library/setup-existing-binding.js";
import { applySetupObservedCollections } from "../../workflows/library/setup-observed-collections.js";
import { result } from "../contracts.js";
import { LibraryStore } from "@smolai/skit-core";
import { checkSubjectsEffect } from "../../workflows/library/check.js";
import { renderCheck } from "../../presentation/check.js";

const workDirFlag = optionalString(
  "work-dir",
  "Repository root to remember for this machine and scan.",
);
const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Observe without updating machine configuration."),
  Flag.withDefault(false),
);

export const setupOwnerHint = (owner: SetupInstanceOwner, paths: readonly string[]): string => {
  const compactPath = (path: string): string => {
    const home = homedir();
    return path === home
      ? "~"
      : path.startsWith(`${home}${sep}`)
        ? `~${path.slice(home.length)}`
        : path;
  };
  switch (owner.kind) {
    case "harness":
      return owner.source;
    case "repository":
      return compactPath(paths[0] ?? owner.repository);
    case "skills-sh":
      return `${paths[0] ? compactPath(paths[0]) : "unknown path"} · skills.sh: ${owner.source}`;
    case "skit":
      return "SKIT";
    case "authored":
      return "Authored here";
    case "invalid-marker":
      return "Invalid SKIT marker";
    case "unknown":
      return paths[0] ? compactPath(paths[0]) : "unknown path";
  }
};

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
  if (!input.interactive || !input.localCustody) return observed;
  yield* renderer.note(renderSetupDiscovery(observed), "Local discovery");
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
  let existingBindingSelections: readonly string[] = [];
  let localCustodySelections: ReadonlyArray<{
    name: string;
    sourcePath?: string;
  }> = [];
  const knownSourceSelections = yield* chooseKnownSources(observed);
  if (knownSourceSelections.length) retainedSourceSelections = knownSourceSelections;
  existingBindingSelections = yield* chooseExistingBindings(observed);
  localCustodySelections = yield* chooseUnmanagedSkills(observed);
  const prompter = yield* Prompter;
  const hasChanges =
    persistRoots ||
    retainedSourceSelections.length > 0 ||
    existingBindingSelections.length > 0 ||
    localCustodySelections.length > 0;
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
            selection.paths.length === candidate.paths.length &&
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
              selection.paths.length === candidate.paths.length &&
              selection.paths.every((path) => candidate.paths.includes(path)),
          ),
      )
      .map((candidate) => candidate.name)
      .sort();
    return { source, names };
  });
  const custodySelections = localCustodySelections.filter((selection) =>
    observed.onboarding.candidates.some(
      (candidate) =>
        candidate.name === selection.name &&
        candidate.action !== "repository-owned" &&
        (selection.sourcePath === undefined || candidate.paths.includes(selection.sourcePath)),
    ),
  );
  const repositorySelections = localCustodySelections.filter((selection) =>
    observed.onboarding.candidates.some(
      (candidate) =>
        candidate.name === selection.name &&
        candidate.action === "repository-owned" &&
        (selection.sourcePath === undefined || candidate.paths.includes(selection.sourcePath)),
    ),
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
          ...existingBindingSelections.map((name) => `  ${name}`),
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
    !localCustodySelections.length
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
  const acquisitionIds = new Set(
    state.acquisitions
      .filter((acquisition) =>
        acquisition.observations.some((observation) => observation.type === "skills.sh-lock"),
      )
      .map((acquisition) => acquisition.acquisition_id),
  );
  const collectionIds = [
    ...new Set(
      state.skills.flatMap((skill) =>
        skill.versions.some((version) =>
          version.origins.some((origin) => acquisitionIds.has(origin.acquisition_id)),
        )
          ? [skill.collection_id]
          : [],
      ),
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
      Effect.forEach(collectionIds, (collectionId) => checkSubjectsEffect(state, {}, collectionId)),
      (results) => Effect.succeed(results.flat()),
    ),
  );
  yield* renderer.note(renderCheck(checks), "Source updates");
});

const chooseKnownSources = Effect.fn("CLI.setup.chooseKnownSources")(function* (
  observed: SetupResult,
) {
  const bySource = new Map<
    string,
    {
      label: string;
      candidates: Array<
        Extract<
          SetupResult["onboarding"]["candidates"][number],
          { action: "import-observed-collection" }
        >
      >;
    }
  >();
  for (const candidate of observed.onboarding.candidates)
    if (candidate.action === "import-observed-collection") {
      const prior = bySource.get(candidate.groupKey);
      bySource.set(candidate.groupKey, {
        label: candidate.source,
        candidates: [...(prior?.candidates ?? []), candidate],
      });
    }
  if (!bySource.size) return [];
  const prompter = yield* Prompter;
  const selectedSources = yield* prompter
    .multiselect(
      "Select skills.sh Collections to add to the SKIT Library",
      [...bySource]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([locator, group]) => ({
          value: locator,
          label: group.label,
          hint: `${group.candidates.length} installed ${group.candidates.length === 1 ? "skill" : "skills"}`,
          selected: true,
        })),
    )
    .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed([])));
  return selectedSources
    .flatMap((source) => bySource.get(source)?.candidates ?? [])
    .map((candidate) => ({
      name: candidate.name,
      paths: candidate.paths,
      groupKey: candidate.groupKey,
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.paths.join("\0").localeCompare(right.paths.join("\0")),
    );
});

const chooseExistingBindings = Effect.fn("CLI.setup.chooseExistingBindings")(function* (
  observed: SetupResult,
) {
  const matches = observed.onboarding.candidates.filter(
    (candidate) => candidate.action === "bind-existing-entry",
  );
  if (!matches.length) return [];
  const prompter = yield* Prompter;
  return yield* prompter
    .multiselect(
      "Select exact matches to reconnect to existing Library content",
      matches.map((candidate) => ({
        value: candidate.name,
        label: candidate.name,
        hint: candidate.collectionDisplayName ?? "existing Library Collection",
        selected: true,
      })),
    )
    .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed([])));
});

const chooseUnmanagedSkills = Effect.fn("CLI.setup.chooseUnmanagedSkills")(function* (
  observed: SetupResult,
) {
  const candidates = observed.onboarding.candidates.filter(
    (candidate) =>
      candidate.action === "manage-locally" ||
      candidate.action === "harness-owned" ||
      candidate.action === "repository-owned",
  );
  if (!candidates.length) return [];
  const prompter = yield* Prompter;
  const choiceValue = (candidate: (typeof candidates)[number]) =>
    candidates.filter((item) => item.name === candidate.name).length === 1
      ? candidate.name
      : `${candidate.name}\0${candidate.paths.join("\0")}`;
  const selectedValues = yield* prompter
    .multiselect(
      "Select installed skills to add to your SKIT Library",
      candidates.map((candidate) => ({
        value: choiceValue(candidate),
        label: `${candidate.name} ${pc.dim(setupOwnerHint(candidate.owner, candidate.paths))}`,
        selected: isSetupCandidateSelectedByDefault(candidate.owner),
      })),
    )
    .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed([])));
  return yield* Effect.forEach(selectedValues, (value) => {
    const candidate = candidates.find((item) => choiceValue(item) === value);
    if (!candidate) return Effect.succeed({ name: value });
    const name = candidate.name;
    if (candidate.action === "manage-locally" && candidate.sourceSelection === "automatic")
      return Effect.succeed({ name, sourcePath: candidate.sourcePath });
    if (candidate.paths.length === 1)
      return Effect.succeed({
        name,
        sourcePath: candidate.paths[0],
      });
    return prompter
      .select(
        `Choose the authoritative copy of ${name}`,
        candidate.paths.map((path) => ({ value: path, label: path })),
      )
      .pipe(
        Effect.map((sourcePath) => ({
          name,
          sourcePath,
        })),
      );
  });
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
