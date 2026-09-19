import {
  LibraryStore,
  type HarnessName as Harness,
  type SkitBindingScope as Scope,
} from "@smolai/skit-core";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { resolve } from "node:path";
import { handleCommand } from "../../application.js";
import { MissingRequirement } from "../failures.js";
import { NothingToSelect, SelectionCancelled } from "../../presentation/interaction-failures.js";
import { UnknownHarness } from "../../harness/failures.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags, optionalString } from "../../commands/parameters.js";
import { harnessAliases, harnessFromAlias } from "../../harness/catalog.js";
import { invocationOptions, type InvocationOption } from "../../invocation/policy.js";
import {
  eligibleHarnesses,
  harnessChoices,
  harnessSupportsScope,
  scopeChoices,
} from "../../library/read-model.js";
import { Prompter, terminalPrompterLayer } from "../../presentation/prompter.js";
import { Renderer } from "../../presentation/renderer.js";
import { promptForScope } from "../../presentation/scope-prompt.js";
import { result } from "../contracts.js";
import { applyLibraryBindings } from "../../workflows/library/portable-set-enabled.js";

const subject = Argument.string("skill-or-collection").pipe(Argument.optional);
const harness = Flag.choice("for", harnessAliases).pipe(
  Flag.withDescription("Select a harness."),
  Flag.optional,
);
const repo = optionalString("repo", "Use repository scope.");
const all = Flag.boolean("all").pipe(
  Flag.withDescription("Select every eligible skill in the collection."),
  Flag.withDefault(false),
);
const invocation = Flag.choice("invocation", invocationOptions).pipe(
  Flag.withDescription(
    "Override model invocation policy; Devin maps explicit to [user], implicit to [user, model], and host-policy preserves authored triggers.",
  ),
  Flag.optional,
);
const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Report projection changes without applying them."),
  Flag.withDefault(false),
);
const DONE = "Done";

const setEnabledCliCommand = (enabled: boolean) => {
  const action = enabled ? "enable" : "disable";
  return Command.make(
    action,
    { subject, harness, repo, all, invocation, dryRun, ...localFlags },
    (input) => {
      const selectedHome = homePath(input.home);
      return handleCommand(
        Effect.gen(function* () {
          const configuration = yield* libraryCommandConfiguration(input);
          const selectedSubject = Option.getOrUndefined(input.subject);
          const requestedAlias = Option.getOrUndefined(input.harness);
          const requested = requestedAlias ? harnessFromAlias(requestedAlias) : undefined;
          if (requestedAlias && !requested)
            return yield* new UnknownHarness({ value: requestedAlias, allowed: harnessAliases });
          const selectedScope = Option.getOrUndefined(
            Option.map(input.repo, (root): Scope => ({ kind: "repository", root: resolve(root) })),
          );
          const selectedInvocation = Option.getOrUndefined(input.invocation) as
            | InvocationOption
            | undefined;
          const interactive = !input.json && Boolean(process.stdin.isTTY && process.stderr.isTTY);

          const store = yield* LibraryStore;
          yield* store.load;
          yield* presentPortableSetEnabled({
            action,
            enabled,
            subject: selectedSubject,
            requested,
            scope: selectedScope,
            cwd: resolve(process.cwd()),
            all: input.all,
            invocation: selectedInvocation,
            dryRun: input.dryRun,
            interactive,
            configuration,
          });
        }).pipe(Effect.provide(terminalPrompterLayer)),
        selectedHome,
      );
    },
  ).pipe(
    Command.withDescription(
      `${enabled ? "Enable" : "Disable"} retained Skills for selected harnesses and scope.`,
    ),
    Command.withExamples(
      enabled
        ? [
            { command: "skit enable review --for codex" },
            { command: "skit enable owner/tools --all --for codex" },
          ]
        : [
            { command: "skit disable review --for codex" },
            { command: "skit disable owner/tools --all --for codex" },
          ],
    ),
    Command.annotate(CommandMetadata, {
      outputSchemas: enabled
        ? [outputContracts.enable, outputContracts.enablePlan]
        : [outputContracts.disable, outputContracts.disablePlan],
      exitCodes: [0, 11, 12, 64, 65],
      interactive: true,
    }),
  );
};

export interface SetEnabledCommandInput {
  readonly action: "enable" | "disable";
  readonly enabled: boolean;
  readonly subject?: string;
  readonly requested?: Harness;
  readonly scope?: Scope;
  readonly cwd: string;
  readonly all: boolean;
  readonly invocation?: InvocationOption;
  readonly dryRun: boolean;
  readonly interactive: boolean;
  readonly configuration: Effect.Success<ReturnType<typeof libraryCommandConfiguration>>;
}

/** Native Collection binding path; interactive selection supplies names from retained membership. */
export const presentPortableSetEnabled = Effect.fn("CLI.setEnabled.portable")(function* (
  input: SetEnabledCommandInput,
) {
  if (input.subject === undefined && !input.interactive)
    return yield* new MissingRequirement({ command: input.action, requires: "a skill" });
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const prompter = yield* Prompter;
  const renderer = yield* Renderer;
  let query = input.subject;
  type EnabledBindingTarget = {
    readonly collectionId: string;
    readonly harness: Harness;
    readonly scope: Scope;
    readonly skillIds: readonly string[];
    readonly location: string;
  };
  let selectedBindings: readonly EnabledBindingTarget[] | undefined;
  if (query === undefined && !input.enabled) {
    const bindings = [...state.global_bindings, ...state.local_bindings]
      .filter(
        (binding) =>
          (input.requested === undefined || binding.harness === input.requested) &&
          (input.scope === undefined ||
            (binding.scope.kind === input.scope.kind &&
              (binding.scope.kind === "global" ||
                (input.scope.kind === "repository" &&
                  resolve(binding.scope.root) === resolve(input.scope.root))))),
      )
      .flatMap((binding, index) => {
        const skills = binding.skills.flatMap((skillId) => {
          const skill = state.skills.find((candidate) => candidate.skill_id === skillId);
          return skill === undefined ? [] : [skill];
        });
        if (skills.length === 0) return [];
        const collectionIds = [...new Set(skills.map((skill) => skill.collection_id))];
        const collection =
          collectionIds.length === 1 && collectionIds[0] !== undefined
            ? state.collections.find((candidate) => candidate.collection_id === collectionIds[0])
            : undefined;
        const subjectId = collection?.collection_id ?? skills[0]!.skill_id;
        const location =
          binding.scope.kind === "global" ? "global" : `repository ${binding.scope.root}`;
        return [
          {
            value: String(index),
            label: `${collection?.label ?? skills.map((skill) => skill.name).join(", ")} — ${binding.harness} · ${location}`,
            hint: skills.map((skill) => skill.name).join(", "),
            target: {
              collectionId: subjectId,
              harness: binding.harness,
              scope: binding.scope,
              skillIds: binding.skills,
              location,
            },
          },
        ];
      });
    if (bindings.length === 0)
      return yield* new NothingToSelect({ detail: "No Skills are currently enabled" });
    const collections = [
      ...new Set(bindings.map((binding) => binding.target.collectionId)),
    ].flatMap((collectionId) => {
      const targets = bindings.filter((binding) => binding.target.collectionId === collectionId);
      if (targets.length < 2) return [];
      const collection = state.collections.find(
        (candidate) => candidate.collection_id === collectionId,
      );
      return [
        {
          value: `all:${collectionId}`,
          label: `${collection?.label ?? collectionId} — everywhere enabled`,
          hint: targets
            .map((binding) => `${binding.target.harness} · ${binding.target.location}`)
            .join(", "),
          targets: targets.map((binding) => binding.target),
        },
      ];
    });
    const choices = [
      ...collections,
      ...bindings.map(({ value, label, hint, target }) => ({
        value,
        label,
        hint,
        targets: [target],
      })),
    ];
    const selectedValue =
      bindings.length === 1
        ? bindings[0]!.value
        : yield* prompter
            .autocomplete(
              "Select where to disable Skills",
              choices.map(({ value, label, hint }) => ({ value, label, hint })),
            )
            .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(DONE)));
    if (selectedValue === DONE) return;
    selectedBindings = choices.find((choice) => choice.value === selectedValue)?.targets;
    if (selectedBindings === undefined || selectedBindings.length === 0) return;
    query = selectedBindings[0]!.collectionId;
  }
  if (query === undefined) {
    const collections = state.collections.filter((collection) =>
      state.skills.some((skill) => skill.collection_id === collection.collection_id),
    );
    if (collections.length === 0)
      return yield* new NothingToSelect({ detail: "The local Library contains no Skills" });
    query = yield* prompter
      .autocomplete(
        "Select a collection",
        collections
          .map((collection): { value: string; label: string } => ({
            value: collection.collection_id,
            label: collection.label,
          }))
          .concat({ value: DONE, label: DONE }),
      )
      .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(DONE)));
    if (query === DONE) return;
  }
  const collection = state.collections.find((candidate) =>
    [candidate.collection_id, candidate.label].includes(query),
  );
  const selected = collection
    ? state.skills.filter(
        (skill) =>
          skill.collection_id === collection.collection_id &&
          (selectedBindings === undefined ||
            selectedBindings.some((binding) => binding.skillIds.includes(skill.skill_id))),
      )
    : undefined;
  let selectedSkills: string[] | undefined;
  if (
    input.interactive &&
    !input.all &&
    selected &&
    (selected.length > 1 || selectedBindings !== undefined)
  ) {
    selectedSkills = yield* prompter
      .multiselect(
        `Select Skills to ${input.action}`,
        selected.map((skill) => ({
          value: skill.name,
          label: skill.name,
          ...(selectedBindings === undefined
            ? {}
            : {
                hint: selectedBindings
                  .filter((binding) => binding.skillIds.includes(skill.skill_id))
                  .map(
                    (binding) =>
                      `${collection?.label ?? binding.collectionId} · ${binding.harness} · ${binding.location}`,
                  )
                  .join(", "),
              }),
        })),
      )
      .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed([])));
    if (selectedSkills.length === 0) return;
  }
  if (selectedBindings !== undefined && selectedBindings.length > 1) {
    const outcomes = yield* renderer.withStatus(
      input.dryRun ? "Planning Collection Bindings" : "Removing retained Projections",
      Effect.forEach(selectedBindings, (binding) => {
        const names = selectedSkills?.filter((name) => {
          const skill = state.skills.find(
            (candidate) =>
              candidate.collection_id === binding.collectionId && candidate.name === name,
          );
          return skill !== undefined && binding.skillIds.includes(skill.skill_id);
        });
        if (names === undefined || names.length === 0) return Effect.succeed(undefined);
        return store.load.pipe(
          Effect.flatMap((current) =>
            applyLibraryBindings(current, {
              query: binding.collectionId,
              all: false,
              selectedSkills: names,
              invocation: {
                subjects: [binding.collectionId],
                harnesses: [binding.harness],
                scope: binding.scope,
                enabled: false,
                dryRun: input.dryRun,
              },
              roots: input.configuration.inventory,
              variantsPath: input.configuration.pull.bindings.variantsPath,
            }),
          ),
        );
      }),
    );
    for (const outcome of outcomes) {
      if (outcome === undefined) continue;
      yield* renderer.result(
        result(
          input.action,
          outcome.kind === "plan" ? outputContracts.disablePlan : outputContracts.disable,
          outcome.value,
        ),
      );
    }
    return;
  }
  const selectedBinding = selectedBindings?.[0];
  let scope = selectedBinding?.scope ?? input.scope ?? ({ kind: "global" } as const);
  if (input.interactive && input.scope === undefined && selectedBinding === undefined) {
    const choices = scopeChoices(input.cwd);
    if (choices.length > 1) {
      const chosen = yield* promptForScope(input.cwd, choices).pipe(
        Effect.catchTag("PromptCancelled", () => Effect.succeed(undefined)),
      );
      if (chosen === undefined) return;
      scope = chosen;
    }
  }
  const harnesses = selectedBinding
    ? [selectedBinding.harness]
    : yield* Effect.gen(function* () {
        const eligible = yield* Effect.fromResult(
          eligibleHarnesses({
            detected: yield* input.configuration.detectedHarnesses,
            ...(input.requested === undefined ? {} : { requested: input.requested }),
          }),
        );
        const candidates = eligible.filter((harness) => harnessSupportsScope(harness, scope.kind));
        return yield* selectHarnesses(prompter, candidates, input.interactive).pipe(
          Effect.catchTag("SelectionCancelled", () => Effect.succeed([])),
        );
      });
  if (harnesses.length === 0) return;
  const outcome = yield* renderer.withStatus(
    input.dryRun
      ? "Planning Collection Bindings"
      : input.enabled
        ? "Projecting retained Skills"
        : "Removing retained Projections",
    applyLibraryBindings(state, {
      query,
      all: input.all,
      ...(selectedSkills === undefined ? {} : { selectedSkills }),
      invocation: {
        subjects: [query],
        harnesses,
        scope,
        enabled: input.enabled,
        ...(input.invocation === undefined ? {} : { invocation: input.invocation }),
        dryRun: input.dryRun,
      },
      roots: input.configuration.inventory,
      variantsPath: input.configuration.pull.bindings.variantsPath,
    }),
  );
  if (outcome.kind === "plan") {
    yield* renderer.result(
      result(
        input.action,
        input.enabled ? outputContracts.enablePlan : outputContracts.disablePlan,
        outcome.value,
      ),
    );
    return;
  }
  yield* renderer.result(
    result(
      input.action,
      input.enabled ? outputContracts.enable : outputContracts.disable,
      outcome.value,
    ),
  );
});

const selectHarnesses = Effect.fn("CLI.selectHarnesses")(function* (
  prompter: Prompter["Service"],
  candidates: Harness[],
  interactive: boolean,
) {
  if (!interactive || candidates.length < 2) return candidates;
  return yield* prompter
    .multiselect<Harness>("Select harnesses", harnessChoices(candidates))
    .pipe(Effect.catchTag("PromptCancelled", () => new SelectionCancelled({ subject: "Harness" })));
});

export const enableCliCommand = setEnabledCliCommand(true);
export const disableCliCommand = setEnabledCliCommand(false);
