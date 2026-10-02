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
import { compactHomePath } from "../../presentation/home-path.js";
import { Renderer } from "../../presentation/renderer.js";
import {
  setupOverviewTitle,
  setupPrompts,
  setupStepPlan,
  type SetupStepPlan,
} from "../../presentation/setup-steps.js";
import {
  readSetupMachineConfig,
  setupRepositoryDecisions,
  revalidateSetupPlan,
  runSetup,
  type SetupOptions,
} from "../../workflows/library/setup.js";
import {
  applySetupLocalCustody,
  retirableShadowAliases,
  type SetupLocalCustodySelection,
  type SetupLocalCustodyOptions,
} from "../../workflows/library/setup-local-custody.js";
import type { SetupResult } from "../../workflows/library/setup-contract.js";
import {
  applySetupExistingBindings,
  type SetupExistingBindingSelection,
} from "../../workflows/library/setup-existing-binding.js";
import { applySetupObservedCollections } from "../../workflows/library/setup-observed-collections.js";
import { result } from "../contracts.js";
import { LibraryStore } from "@smolai/skit-core";
import { checkSubjectsEffect } from "../../workflows/library/check.js";
import { renderCheck } from "../../presentation/check.js";
import { setupDiscoveredSkillChoices } from "../../presentation/setup-skills.js";
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
      setupRepositoryDecisions(configured).map((decision) => [decision.path, decision.status]),
    );
    const decisionsChanged = repositoryDecisions.some(
      (decision) => configuredDecisions.get(decision.path) !== decision.status,
    );
    persistRoots = !input.dryRun && (persistRoots || decisionsChanged);
    observed = yield* observe({ ...setupOptions, persistRoots: false });
  }
  const retainedSourceSelections = yield* chooseKnownSources(steps, observed);
  const { bind, add, remove, removablePaths } = yield* chooseDiscoveredSkills(
    steps,
    setupOptions,
    observed,
  );
  const localCustodySelections: SetupLocalCustodySelection[] = [];
  const duplicatePrompter = yield* Prompter;
  const chooseDuplicateAction = Effect.fn("CLI.setup.duplicateAction")(function* (selection: {
    name: string;
    sourcePath: string;
  }) {
    const candidate = observed.onboarding.candidates.find(
      (item) => item.name === selection.name && item.paths.includes(selection.sourcePath),
    );
    const instance = observed.instances.find((item) => item.path === selection.sourcePath);
    const shadows = candidate?.shadows ?? [];
    if (!shadows.length || instance?.git.repository || instance?.scope !== "global") {
      return undefined;
    }
    const aliases = retirableShadowAliases(selection.sourcePath, shadows);
    yield* renderer.note(
      shadows
        .flatMap((shadow) =>
          shadow.aliases.map(
            (alias) =>
              `${displayPath(alias.path)}${alias.via === "symlink" ? ` → ${displayPath(shadow.canonicalPath)} (symlink)` : " (directory)"}`,
          ),
        )
        .join("\n"),
      `${selection.name}: enabling would create another agent copy`,
    );
    const action = yield* duplicatePrompter.select(`How should setup handle ${selection.name}?`, [
      ...(aliases.length
        ? [
            {
              value: "retire-aliases" as const,
              label: "Manage with SKIT and retire redundant symlinks",
              hint: "Source stays in place; links saved with a recovery receipt",
            },
          ]
        : []),
      { value: "retain-only" as const, label: "Retain in Library without enabling" },
      {
        value: "keep-both" as const,
        label: "Keep both copies and enable",
        hint: "The agent may discover duplicate skills",
      },
    ]);
    return action;
  });
  const duplicateKey = (selection: { name: string; sourcePath: string }) =>
    JSON.stringify([selection.name, selection.sourcePath]);
  const duplicateSelections = [
    ...add,
    ...bind.map(({ name, path }) => ({ name, sourcePath: path })),
  ].flatMap((selection) => {
    const candidate = observed.onboarding.candidates.find(
      (item) => item.name === selection.name && item.paths.includes(selection.sourcePath),
    );
    const instance = observed.instances.find((item) => item.path === selection.sourcePath);
    const shadows = candidate?.shadows ?? [];
    if (!shadows.length || instance?.git.repository || instance?.scope !== "global") return [];
    return [{ selection, shadows, aliases: retirableShadowAliases(selection.sourcePath, shadows) }];
  });
  const bulkActions = new Map<string, NonNullable<SetupLocalCustodySelection["duplicateAction"]>>();
  for (const retirable of [true, false]) {
    const group = duplicateSelections.filter((item) => item.aliases.length > 0 === retirable);
    if (group.length < 2) continue;
    const aliasCount = new Set(group.flatMap((item) => item.aliases)).size;
    const examples = [
      ...new Set(
        group.flatMap(({ shadows }) =>
          shadows.flatMap((shadow) =>
            shadow.aliases.map(
              (alias) =>
                `${displayPath(alias.path)}${alias.via === "symlink" ? ` → ${displayPath(shadow.canonicalPath)} (symlink${alias.linkPath && alias.linkPath !== alias.path ? ` at ${displayPath(alias.linkPath)}` : ""})` : " (directory)"}`,
            ),
          ),
        ),
      ),
    ];
    yield* renderer.note(
      [
        ...(retirable
          ? []
          : [
              "These locations are not all individual symlinks to the selected source. Retain without enabling to avoid another agent copy.",
            ]),
        ...examples.slice(0, 5),
        ...(examples.length > 5 ? [`… and ${examples.length - 5} more locations`] : []),
      ].join("\n"),
      `${group.length} skills: enabling would create another agent copy`,
    );
    const action = yield* duplicatePrompter.select(
      `How should setup handle these ${group.length} skills?`,
      [
        ...(retirable
          ? [
              {
                value: "retire-aliases" as const,
                label: `Retire redundant symlinks for all ${group.length} skills (${aliasCount} symlinks)`,
                hint: "Source directories stay; recovery receipts saved",
              },
            ]
          : []),
        { value: "retain-only" as const, label: "Retain all in Library without enabling" },
        {
          value: "keep-both" as const,
          label: "Keep both copies and enable all",
          hint: "The agent may discover duplicate skills",
        },
        { value: "individual" as const, label: "Choose individually" },
      ],
    );
    if (action !== "individual")
      for (const { selection } of group) bulkActions.set(duplicateKey(selection), action);
  }
  for (const selection of add) {
    const duplicateAction =
      bulkActions.get(duplicateKey(selection)) ?? (yield* chooseDuplicateAction(selection));
    localCustodySelections.push({ ...selection, ...(duplicateAction ? { duplicateAction } : {}) });
  }
  const existingBindingSelections: SetupExistingBindingSelection[] = [];
  for (const selection of bind) {
    const duplicateSelection = { name: selection.name, sourcePath: selection.path };
    const duplicateAction =
      bulkActions.get(duplicateKey(duplicateSelection)) ??
      (yield* chooseDuplicateAction(duplicateSelection));
    existingBindingSelections.push({
      ...selection,
      ...(duplicateAction ? { duplicateAction } : {}),
    });
  }
  const removalPlan = yield* planSetupRemovals(setupOptions, observed, remove, removablePaths);
  const prompter = yield* Prompter;
  const hasChanges =
    persistRoots ||
    retainedSourceSelections.length > 0 ||
    existingBindingSelections.length > 0 ||
    localCustodySelections.length > 0 ||
    removalPlan.entries.length > 0;
  if (!hasChanges) {
    yield* renderer.step(
      steps.step("confirm"),
      "Nothing was selected and the repository roots are unchanged, so there is nothing to apply.",
    );
    yield* offerSkillsShUpdateCheck();
    return observed;
  }
  const imports = observed.onboarding.candidates.filter(
    (candidate) => candidate.action === "import-observed-collection",
  );
  const retainedBySource = [
    ...new Set(retainedSourceSelections.map((selection) => selection.groupKey)),
  ].map((groupKey) => ({
    source: imports.find((candidate) => candidate.groupKey === groupKey)!,
    names: retainedSourceSelections
      .filter((selection) => selection.groupKey === groupKey)
      .map((selection) => selection.name)
      .sort(),
  }));
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
    (selection) =>
      !repositorySelections.includes(selection) && selection.duplicateAction !== "retain-only",
  );
  const reconnectSelections = existingBindingSelections.filter(
    (selection) => selection.duplicateAction !== "retain-only",
  );
  const skillCount = (count: number) => `${count} skill${count === 1 ? "" : "s"}`;
  const planLines = [
    ...(persistRoots ? [`Save discovery roots: ${displayRoots}`] : []),
    ...repositoryDecisions.map(
      (decision) =>
        `${decision.status === "watched" ? "Watch" : "Ignore"} repository: ${displayPath(decision.path)}`,
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
    ...(reconnectSelections.length
      ? [
          `Reconnect existing Library matches: ${reconnectSelections.length}`,
          ...reconnectSelections
            .slice(0, 5)
            .map(({ name, path }) => `  ${name} · ${displayPath(path)}`),
          ...(reconnectSelections.length > 5
            ? [`  … and ${reconnectSelections.length - 5} more`]
            : []),
        ]
      : []),
    ...(localCustodySelections.length
      ? [
          `Add to Library: ${localCustodySelections.length}`,
          ...localCustodySelections
            .slice(0, 5)
            .map((selection) => `  ${selection.name} · ${displayPath(selection.sourcePath)}`),
          ...(localCustodySelections.length > 5
            ? [`  … and ${localCustodySelections.length - 5} more`]
            : []),
        ]
      : []),
    ...(["retain-only", "retire-aliases", "keep-both"] as const).flatMap((action) => {
      const selections = [...localCustodySelections, ...existingBindingSelections].filter(
        (selection) => selection.duplicateAction === action,
      );
      if (!selections.length) return [];
      const names =
        selections.length <= 5
          ? ` · ${selections.map((selection) => selection.name).join(", ")}`
          : "";
      if (action === "retain-only")
        return [
          `Retain only: ${skillCount(selections.length)}${names} · no new Binding or Projection`,
        ];
      if (action === "keep-both")
        return [`Allow duplicate agent copies: ${skillCount(selections.length)}${names}`];
      const aliases = new Set(
        duplicateSelections
          .filter(({ selection }) =>
            selections.some(
              (item) =>
                item.name === selection.name &&
                ("sourcePath" in item ? item.sourcePath : item.path) === selection.sourcePath,
            ),
          )
          .flatMap((item) => item.aliases),
      );
      return [
        `Retire redundant symlinks: ${skillCount(selections.length)} · ${aliases.size} symlink${aliases.size === 1 ? "" : "s"}${names} · sources stay; recovery receipts saved`,
      ];
    }),
    ...(custodySelections.length ? [`Take custody: ${custodySelections.length}`] : []),
    ...localCustodySelections.flatMap((selection) => {
      const candidate = observed.onboarding.candidates.find((item) =>
        item.paths.includes(selection.sourcePath),
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
  yield* renderer.step(steps.step("confirm"), planLines.join("\n"));
  const approved = yield* prompter.confirm(setupPrompts.confirm);
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
    const applied = yield* renderer.withStatus(
      reconnectSelections.length
        ? `Reconnecting ${reconnectSelections.length} existing Library match${reconnectSelections.length === 1 ? "" : "es"}`
        : "Keeping existing Library matches without enabling",
      applySetupExistingBindings(
        { setup: setupOptions, bindings: input.localCustody.bindings },
        observed.onboarding.planId,
        existingBindingSelections,
      ),
    );
    for (const warning of applied.warnings)
      yield* renderer.note(warning.message, `${warning.name}: alias preserved`);
    if (applied.recoveryDirectories.length)
      yield* renderer.note(
        `Sources stay in place. Symlinks and restoration receipts are saved in:\n${applied.recoveryDirectories.join("\n")}`,
        `Redundant symlinks retired for ${skillCount(applied.recoveryDirectories.length)}${applied.warnings.length ? ` · ${skillCount(applied.warnings.length)} preserved` : ""}`,
      );
  }
  if (localCustodySelections.length) {
    observed = yield* observe(setupOptions);
    const names =
      localCustodySelections.length <= 5
        ? `: ${localCustodySelections.map((selection) => selection.name).join(", ")}`
        : "";
    const applied = yield* renderer.withStatus(
      `Taking custody of ${localCustodySelections.length} local Skill${localCustodySelections.length === 1 ? "" : "s"}${names}`,
      applySetupLocalCustody(
        { setup: setupOptions, adoption: input.localCustody },
        observed.onboarding.planId,
        localCustodySelections,
      ),
    );
    for (const warning of applied.warnings)
      yield* renderer.note(warning.message, `${warning.name}: alias preserved`);
    if (applied.recoveryDirectories.length)
      yield* renderer.note(
        `Sources stay in place. Symlinks and restoration receipts are saved in:\n${applied.recoveryDirectories.join("\n")}`,
        `Redundant symlinks retired for ${skillCount(applied.recoveryDirectories.length)}${applied.warnings.length ? ` · ${skillCount(applied.warnings.length)} preserved` : ""}`,
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
      ? [{ name: candidate.name, path: instance.path }]
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
