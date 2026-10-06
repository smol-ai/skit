import { bindingSkillIds, LibraryStore, type SkitBindingScope as Scope } from "@smolai/skit-core";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolve } from "node:path";
import { handleCommand } from "../../application.js";
import { MissingRequirement } from "../failures.js";
import { NothingToSelect } from "../../presentation/interaction-failures.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags, optionalString } from "../../commands/parameters.js";
import { invocationOptions, type InvocationOption } from "../../invocation/policy.js";
import { destinationLabel, scopeChoices } from "../../library/read-model.js";
import { Prompter, terminalPrompterLayer } from "../../presentation/prompter.js";
import { Renderer } from "../../presentation/renderer.js";
import { promptForScope } from "../../presentation/scope-prompt.js";
import { result } from "../contracts.js";
import { applyLibraryBindings } from "../../workflows/library/set-enabled.js";

const subject = Argument.String("skill-or-collection").pipe(Argument.optional);
const repo = optionalString("repo", "Use repository scope.");
const all = Flag.Boolean("all").pipe(
  Flag.withDescription("Select every eligible skill in the collection."),
  Flag.withDefault(false),
);
const invocation = Flag.Literals("invocation", invocationOptions).pipe(
  Flag.withDescription(
    "Override model invocation policy for every agent; Devin maps explicit to [user], implicit to [user, model], and host-policy preserves authored triggers.",
  ),
  Flag.optional,
);
const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Report projection changes without applying them."),
  Flag.withDefault(false),
);
const allowDuplicate = Flag.Boolean("allow-duplicate").pipe(
  Flag.withDescription(
    "Explicitly allow another same-scope copy of a skill already discoverable by an agent.",
  ),
  Flag.withDefault(false),
);
const DONE = "Done";

const setEnabledCliCommand = (enabled: boolean) => {
  const action = enabled ? "enable" : "disable";
  return Command.make(
    action,
    {
      subject,
      repo,
      all,
      invocation,
      dryRun,
      ...(enabled ? { allowDuplicate } : {}),
      ...localFlags,
    },
    (input) => {
      const selectedHome = homePath(input.home);
      return handleCommand(
        Effect.gen(function* () {
          const configuration = yield* libraryCommandConfiguration(input);
          const selectedSubject = Option.getOrUndefined(input.subject);
          const selectedScope = Option.getOrUndefined(
            Option.map(input.repo, (root): Scope => ({ kind: "repository", root: resolve(root) })),
          );
          const selectedInvocation = Option.getOrUndefined(input.invocation) as
            | InvocationOption
            | undefined;
          const interactive = !input.json && Boolean(process.stdin.isTTY && process.stderr.isTTY);

          const store = yield* LibraryStore;
          yield* store.load;
          yield* presentSetEnabled({
            action,
            enabled,
            subject: selectedSubject,
            scope: selectedScope,
            cwd: resolve(process.cwd()),
            all: input.all,
            allowDuplicate: input.allowDuplicate,
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
      `${enabled ? "Enable" : "Disable"} retained Skills for every agent at a scope.`,
    ),
    Command.withExamples(
      enabled
        ? [{ command: "skit enable review" }, { command: "skit enable owner/tools --all" }]
        : [{ command: "skit disable review" }, { command: "skit disable owner/tools --all" }],
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
  readonly scope?: Scope;
  readonly cwd: string;
  readonly all: boolean;
  readonly allowDuplicate?: boolean;
  readonly invocation?: InvocationOption;
  readonly dryRun: boolean;
  readonly interactive: boolean;
  readonly configuration: Effect.Success<ReturnType<typeof libraryCommandConfiguration>>;
}

/** Native Collection binding path; interactive selection supplies names from retained membership. */
export const presentSetEnabled = Effect.fn("CLI.setEnabled.portable")(function* (
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
    readonly scope: Scope;
    readonly skillIds: readonly string[];
    readonly location: string;
  };
  let selectedBindings: readonly EnabledBindingTarget[] | undefined;
  if (query === undefined && !input.enabled) {
    const bindings = [...state.global_bindings, ...state.local_bindings]
      .filter(
        (binding) =>
          input.scope === undefined ||
          (binding.scope.kind === input.scope.kind &&
            (binding.scope.kind === "global" ||
              (input.scope.kind === "repository" &&
                resolve(binding.scope.root) === resolve(input.scope.root)))),
      )
      .flatMap((binding, index) => {
        const skillIds = bindingSkillIds(state, binding);
        const skills = skillIds.flatMap((skillId) => {
          const skill = state.skills.find((candidate) => candidate.skill_id === skillId);
          return skill === undefined ? [] : [skill];
        });
        const collectionIds = [
          ...new Set([
            ...skills.map((skill) => skill.collection_id),
            ...binding.entries.flatMap((entry) =>
              entry.kind === "collection" ? [entry.collection_id] : [],
            ),
          ]),
        ];
        const location =
          binding.scope.kind === "global" ? "global" : `repository ${binding.scope.root}`;
        return collectionIds.map((collectionId) => {
          const collection = state.collections.find(
            (candidate) => candidate.collection_id === collectionId,
          );
          const members = skills.filter((skill) => skill.collection_id === collectionId);
          return {
            value: `${index}:${collectionId}`,
            label: `${collection?.label ?? members.map((skill) => skill.name).join(", ")} — ${location}`,
            hint: members.map((skill) => skill.name).join(", "),
            target: {
              collectionId,
              scope: binding.scope,
              skillIds: members.map((skill) => skill.skill_id),
              location,
            },
          };
        });
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
          hint: targets.map((binding) => binding.target.location).join(", "),
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
    const selectedValue = yield* prompter
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
  let wholeCollection = input.all;
  if (input.interactive && collection !== undefined && !wholeCollection) {
    const selection = yield* prompter
      .select("What would you like to " + input.action + "?", [
        {
          value: "collection",
          label: input.enabled ? "Enable whole collection" : "Disable whole collection",
          hint: input.enabled
            ? "Include new skills and remove deleted ones when you update"
            : "Disable every skill in this collection",
        },
        ...(selected?.length
          ? [
              {
                value: "skills",
                label: "Select individual Skills",
                hint: "Only the selected Skills",
              },
            ]
          : []),
      ])
      .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(DONE)));
    if (selection === DONE) return;
    wholeCollection = selection === "collection";
  }
  let selectedSkills: string[] | undefined;
  if (
    input.interactive &&
    !wholeCollection &&
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
                      `${collection?.label ?? binding.collectionId} · ${binding.location}`,
                  )
                  .join(", "),
              }),
        })),
      )
      .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed([])));
    if (selectedSkills.length === 0) return;
  }
  if (
    input.interactive &&
    !input.enabled &&
    wholeCollection &&
    collection !== undefined &&
    input.scope === undefined &&
    selectedBindings === undefined
  ) {
    const targets = [...state.global_bindings, ...state.local_bindings]
      .filter(
        (binding) =>
          binding.entries.some(
            (entry) =>
              entry.kind === "collection" && entry.collection_id === collection.collection_id,
          ) ||
          bindingSkillIds(state, binding).some((id) =>
            state.skills.some(
              (skill) => skill.skill_id === id && skill.collection_id === collection.collection_id,
            ),
          ),
      )
      .map((binding) => ({
        collectionId: collection.collection_id,
        scope: binding.scope,
        skillIds: bindingSkillIds(state, binding),
        location: destinationLabel(binding.scope),
      }));
    if (!targets.length) {
      yield* renderer.note("This collection is not enabled anywhere.", "Nothing to change");
      return;
    }
    const chosen =
      targets.length === 1
        ? "0"
        : yield* prompter
            .autocomplete("Select where to disable Skills", [
              { value: "all", label: "All shown" },
              ...targets.map((target, index) => ({ value: String(index), label: target.location })),
            ])
            .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(DONE)));
    if (chosen === DONE) return;
    selectedBindings = chosen === "all" ? targets : [targets[Number(chosen)]!];
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
        if (!wholeCollection && (names === undefined || names.length === 0))
          return Effect.succeed(undefined);
        return store.load.pipe(
          Effect.flatMap((current) =>
            applyLibraryBindings(current, {
              query: binding.collectionId,
              all: wholeCollection,
              ...(wholeCollection ? {} : { selectedSkills: names }),
              invocation: {
                subjects: [binding.collectionId],
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
  const outcome = yield* renderer.withStatus(
    input.dryRun
      ? "Planning Collection Bindings"
      : input.enabled
        ? "Projecting retained Skills"
        : "Removing retained Projections",
    applyLibraryBindings(state, {
      query,
      all: wholeCollection,
      allowDuplicate: input.allowDuplicate,
      ...(selectedSkills === undefined ? {} : { selectedSkills }),
      invocation: {
        subjects: [query],
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

export const enableCliCommand = setEnabledCliCommand(true);
export const disableCliCommand = setEnabledCliCommand(false);
