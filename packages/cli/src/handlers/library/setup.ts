import {
  SkitConfiguration,
  skitConfigurationLayer,
} from "../../configuration/skit-configuration.js";
import { skillModificationTime } from "../../library-application/skill-metadata.js";
import { Effect, FileSystem, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { join, resolve } from "node:path";
import { handleSourceCommand } from "../../application.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { localFlags, optionalString } from "../../commands/parameters.js";
import { Prompter, terminalPrompterLayer } from "../../presentation/prompter.js";
import { compactHomePath } from "../../presentation/home-path.js";
import { Renderer } from "../../presentation/renderer.js";
import {
  setupOverviewTitle,
  setupPrompts,
  setupStepPlan,
  type SetupStepPlan,
} from "../../presentation/setup-steps.js";
import { runSetup, type SetupOptions } from "../../workflows/library/setup.js";
import { applySetupPlan, type SetupApproval } from "../../workflows/library/setup-apply.js";
import type { LocalAdoptionOptions } from "../../workflows/library/local-adoption.js";
import type { SetupResult } from "../../workflows/library/setup-contract.js";
import { result } from "../contracts.js";
import { LibraryStore, MachineSettings } from "@smolai/skit-core";
import { checkSubjectsEffect } from "../../workflows/library/check.js";
import { renderCheck } from "../../presentation/check.js";
import { setupDiscoveredSkillChoices } from "../../presentation/setup-skills.js";
import { planSetupRemovals, setupRemovablePaths } from "../../workflows/library/setup-removal.js";

import { setupSelectedCopies } from "../../workflows/library/setup-decisions.js";
import {
  chooseSetupCopyDecisions,
  setupPlanLines,
  renderSetupAliasRecovery,
} from "../../presentation/setup-choice-presentation.js";

const workDirFlag = optionalString(
  "work-dir",
  "Repository root to remember for this machine and scan.",
);
const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Observe without updating machine configuration."),
  Flag.withDefault(false),
);

export const shouldSetupInteractively = (input: {
  readonly json: boolean;
  readonly dryRun: boolean;
  readonly stdin: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
}): boolean => !input.json && !input.dryRun && input.stdin && input.stdout && input.stderr;

export const setupCommand = Effect.fn("CLI.setup")(function* (input: {
  readonly options: Omit<SetupOptions, "repositoryRoots" | "persistRoots">;
  readonly localCustody?: LocalAdoptionOptions;
  readonly interactive: boolean;
  readonly dryRun: boolean;
  readonly workDirFlag?: string;
}) {
  const configured = yield* MachineSettings.read(input.options.libraryHome);
  const roots = input.workDirFlag ? [resolve(input.workDirFlag)] : [];
  let persistRoots = Boolean(input.workDirFlag) && !input.dryRun;
  let setupOptions: SetupOptions = {
    ...input.options,
    repositoryRoots: roots,
    persistRoots: !input.interactive && persistRoots,
  };
  const renderer = yield* Renderer;
  const guided = input.interactive && !input.dryRun && input.localCustody !== undefined;
  const steps = setupStepPlan({ scanRepositories: roots.length > 0 });
  if (guided) yield* renderer.note(steps.overview, setupOverviewTitle);
  const observe = (options: SetupOptions) =>
    renderer.withStatus("Observing local skills", runSetup(options));
  let observed = yield* observe(setupOptions);
  if (!guided || !input.localCustody) return observed;
  const discoveredRepositories = observed.repositories;
  const displayPath = (path: string) => compactHomePath(path, input.options.inventory.home);
  const displayRoots = roots.map(displayPath).join(", ");
  if (roots.length)
    yield* renderer.step(
      steps.step("repositories"),
      discoveredRepositories.length
        ? `Found ${discoveredRepositories.length} ${discoveredRepositories.length === 1 ? "repository" : "repositories"} with skills under ${displayRoots}. SKIT ignores the ones you leave unselected.`
        : `No repositories with skills were found under ${displayRoots}.`,
    );
  let repositoryDecisions: ReadonlyArray<{
    path: string;
    status: "watched" | "ignored";
  }> = [];
  if (discoveredRepositories.length) {
    const prompter = yield* Prompter;
    const watched = yield* prompter.multiselect(
      setupPrompts.repositories,
      discoveredRepositories.map((repository) => ({
        value: repository.path,
        label: displayPath(repository.path),
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
      configured.repositories.map((decision) => [decision.path, decision.status]),
    );
    const decisionsChanged = repositoryDecisions.some(
      (decision) => configuredDecisions.get(decision.path) !== decision.status,
    );
    persistRoots = !input.dryRun && (persistRoots || decisionsChanged);
    observed = yield* observe({ ...setupOptions, persistRoots: false });
  }
  const imports = yield* chooseKnownSources(steps, observed);
  const { bind, add, remove, removablePaths } = yield* chooseDiscoveredSkills(
    steps,
    setupOptions,
    observed,
  );
  const decisions = yield* chooseSetupCopyDecisions(
    setupSelectedCopies(observed, add, bind),
    displayPath,
  );
  const approval: SetupApproval = {
    setup: setupOptions,
    planId: observed.onboarding.planId,
    persistRoots,
    imports,
    bindings: decisions.filter((copy) => copy.operation === "bind"),
    custody: decisions.filter((copy) => copy.operation === "add"),
    removals: yield* planSetupRemovals(setupOptions, observed, remove, removablePaths),
  };
  if (
    !persistRoots &&
    !imports.length &&
    !approval.bindings.length &&
    !approval.custody.length &&
    !approval.removals.entries.length
  ) {
    yield* renderer.step(
      steps.step("confirm"),
      "Nothing was selected and the repository roots are unchanged, so there is nothing to apply.",
    );
    yield* offerSkillsShUpdateCheck();
    return observed;
  }
  yield* renderer.step(
    steps.step("confirm"),
    setupPlanLines({
      approval,
      observed,
      decisions,
      repositoryDecisions,
      displayRoots,
      displayPath,
    }).join("\n"),
  );
  const prompter = yield* Prompter;
  if (!(yield* prompter.confirm(setupPrompts.confirm))) {
    yield* renderer.note("No changes were applied.", "Setup cancelled");
    return observed;
  }
  const applied = yield* applySetupPlan(
    { adoption: input.localCustody, withStatus: renderer.withStatus },
    approval,
  );
  yield* renderSetupAliasRecovery(applied);
  if (approval.removals.entries.length)
    yield* renderer.note(
      `Removed installed locations are saved at ${approval.removals.recoveryDirectory}. Move each entry back to its original path recorded in receipt.json to restore it.`,
      "Removed copies saved",
    );
  yield* renderer.note("Selected setup changes were applied.", "Setup complete");
  yield* offerSkillsShUpdateCheck();
  return applied.observed;
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

const chooseKnownSources = Effect.fn("CLI.setup.chooseKnownSources")(function* (
  steps: SetupStepPlan,
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
  const renderer = yield* Renderer;
  if (!bySource.size) {
    yield* renderer.step(steps.step("collections"), "No skills.sh collections to add.");
    return [];
  }
  yield* renderer.step(
    steps.step("collections"),
    `Found ${bySource.size} installed skills.sh collection${bySource.size === 1 ? "" : "s"} not yet in the SKIT Library.`,
  );
  const prompter = yield* Prompter;
  const selectedSources = yield* prompter
    .multiselect(
      setupPrompts.collections,
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

const chooseDiscoveredSkills = Effect.fn("CLI.setup.chooseDiscoveredSkills")(function* (
  steps: SetupStepPlan,
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
      const modified = yield* skillModificationTime(row.instance.path);
      const path = join(row.instance.path, "SKILL.md");
      return {
        ...row.choice,
        ...((removablePaths.get(row.instance.path)?.length ?? 0) > 0
          ? { removeValue: `remove\0${row.choice.value}` }
          : {}),
        searchText: `${row.details} · SKILL.md modified ${modified?.slice(0, 10) ?? "unavailable"}`,
        preview: () =>
          fs.readFileString(path).pipe(
            Effect.map(
              (content) =>
                `${path}\n${row.details}\nSKILL.md modified ${modified?.slice(0, 10) ?? "unavailable"}\n\n${content.length > 65_536 ? `${content.slice(0, 65_536)}\n\n[Preview truncated at 65,536 characters]` : content}`,
            ),
            Effect.orElseSucceed(
              () =>
                `${path}\n${row.details}\nSKILL.md modified ${modified?.slice(0, 10) ?? "unavailable"}\n\nContent unavailable: the file could not be read.`,
            ),
          ),
      };
    }),
  );
  const skillNames = new Set(rows.map((row) => row.instance.name)).size;
  const renderer = yield* Renderer;
  yield* renderer.step(
    steps.step("skills"),
    choices.length
      ? `Found ${skillNames} other installed skill${skillNames === 1 ? "" : "s"} in ${rows.length} location${rows.length === 1 ? "" : "s"}.`
      : "No other installed skills to review.",
  );
  const selectedValues = choices.length
    ? yield* prompter
        .multiselect(setupPrompts.skills, choices)
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

  const bind = selectedRows.flatMap(({ instance, candidate }) =>
    candidate?.action === "bind-existing-entry"
      ? [{ name: candidate.name, sourcePath: instance.path }]
      : [],
  );
  const remove = rows
    .filter((row) => selectedValues.includes(`remove\0${row.choice.value}`))
    .map(({ instance }) => ({ name: instance.name, paths: [instance.path] }));
  return { add, bind, remove, removablePaths };
});

export const setupCliCommand = Command.make(
  "setup",
  { workDir: workDirFlag, dryRun, ...localFlags },
  (input) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;

      const selectedHome = paths.skitHome;
      const interactive = shouldSetupInteractively({
        json: input.json,
        dryRun: input.dryRun,
        stdin: Boolean(process.stdin.isTTY),
        stdout: Boolean(process.stdout.isTTY),
        stderr: Boolean(process.stderr.isTTY),
      });
      return yield* handleSourceCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const configuration = yield* libraryCommandConfiguration(input);
          const value = yield* setupCommand({
            workDirFlag: Option.getOrUndefined(input.workDir),
            interactive,
            dryRun: input.dryRun || input.json,
            options: {
              libraryHome: selectedHome,
              inventory: configuration.inventory,
              probePath: process.env.PATH,
              skillsStateHome: paths.xdgStateHome,
            },
            localCustody: {
              bindings: configuration.pull.bindings,
            },
          });
          if (!interactive) yield* renderer.result(result("setup", value));
        }).pipe(Effect.provide(terminalPrompterLayer)),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
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
