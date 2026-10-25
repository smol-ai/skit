import { OptionCombinationInvalid } from "../../workflows/failures.js";
import { promptsAllowed } from "../../presentation/interactivity.js";
import { skitConfigurationLayer } from "../../configuration/skit-configuration.js";
import type { SkitBindingScope as Scope } from "@smolai/skit-core";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolve } from "node:path";
import { handleLibraryCommand } from "../../application.js";
import { MissingRequirement } from "../../workflows/failures.js";
import { NothingToSelect } from "../../presentation/interaction-failures.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { localFlags, optionalString } from "../../commands/parameters.js";
import { invocationOptions, type InvocationOption } from "../../invocation/policy.js";
import { scopeChoices } from "../../library-application/read-model.js";
import { Prompter, terminalPrompterLayer } from "../../presentation/prompter.js";
import { Renderer } from "../../presentation/renderer.js";
import { promptForScope } from "../../presentation/scope-prompt.js";
import { result } from "../contracts.js";
import {
  applyBindingChanges,
  openBindingChangeSelection,
  type BindingChangeIntent,
  type BindingPlacement,
} from "../../library-application/binding-changes.js";
import {
  largeCollectionWarning,
  descriptionLoadMessage,
} from "../../workflows/library/collection-load.js";

const subject = Argument.String("skill-or-collection").pipe(Argument.optional);
const repo = optionalString("repo", "Use repository scope.");
const global = Flag.Boolean("global").pipe(
  Flag.withDescription("Use global scope, for every project, without asking."),
  Flag.withDefault(false),
);
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
      global,
      all,
      invocation,
      dryRun,
      ...(enabled ? { allowDuplicate } : {}),
      ...localFlags,
    },
    (input) =>
      handleLibraryCommand(
        Effect.gen(function* () {
          if (input.global && Option.isSome(input.repo))
            return yield* new OptionCombinationInvalid({
              detail: "Choose one scope: --global or --repo <path>",
            });
          const configuration = yield* libraryCommandConfiguration(input);
          const selectedSubject = Option.getOrUndefined(input.subject);
          const selectedScope: Scope | undefined = input.global
            ? { kind: "global" }
            : Option.getOrUndefined(
                Option.map(input.repo, (root): Scope => ({
                  kind: "repository",
                  root: resolve(root),
                })),
              );
          const selectedInvocation = Option.getOrUndefined(input.invocation) as
            | InvocationOption
            | undefined;
          const interactive = promptsAllowed({ json: input.json });

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
      ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
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

type EnabledTarget = BindingPlacement & { readonly location: string };
const withLocation = (placement: BindingPlacement): EnabledTarget => ({
  ...placement,
  location: placement.scope.kind === "global" ? "global" : `repository ${placement.scope.root}`,
});

/** Native Collection binding path; interactive selection supplies names from retained membership. */
export const presentSetEnabled = Effect.fn("CLI.setEnabled.portable")(function* (
  input: SetEnabledCommandInput,
) {
  if (input.subject === undefined && !input.interactive)
    return yield* new MissingRequirement({ command: input.action, requires: "a skill" });
  const selection = yield* openBindingChangeSelection();
  const view = selection.view;
  const prompter = yield* Prompter;
  const renderer = yield* Renderer;
  const collectionLabel = (collectionId: string) =>
    view.collections.find((collection) => collection.id === collectionId)?.label;
  const skillNames = (skillIds: readonly string[]) =>
    skillIds
      .flatMap(
        (skillId) =>
          view.collections
            .flatMap((collection) => collection.members)
            .find((skill) => skill.id === skillId)?.name ?? [],
      )
      .join(", ");

  let query = input.subject;
  // Disabling without a subject starts from where Skills are enabled.
  let targets: readonly EnabledTarget[] | undefined;
  if (query === undefined && !input.enabled) {
    const enabled = view.placementsAt(input.scope).map(withLocation);
    if (enabled.length === 0)
      return yield* new NothingToSelect({ detail: "No Skills are currently enabled" });
    const everywhere = [...new Set(enabled.map((target) => target.collectionId))].flatMap(
      (collectionId) => {
        const all = enabled.filter((target) => target.collectionId === collectionId);
        if (all.length < 2) return [];
        return [
          {
            value: `all:${collectionId}`,
            label: `${collectionLabel(collectionId) ?? collectionId} — everywhere enabled`,
            hint: all.map((target) => target.location).join(", "),
            targets: all,
          },
        ];
      },
    );
    const choices = [
      ...everywhere,
      ...enabled.map((target, index) => ({
        value: `${index}:${target.collectionId}`,
        label: `${collectionLabel(target.collectionId) ?? skillNames(target.skillIds)} — ${target.location}`,
        hint: skillNames(target.skillIds),
        targets: [target],
      })),
    ];
    const chosen = yield* prompter
      .autocomplete(
        "Select where to disable Skills",
        choices.map(({ value, label, hint }) => ({ value, label, hint })),
      )
      .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(DONE)));
    targets = choices.find((choice) => choice.value === chosen)?.targets;
    if (targets === undefined) return;
    query = targets[0]!.collectionId;
  }
  if (query === undefined) {
    const collections = view.collections.filter((collection) => collection.members.length > 0);
    if (collections.length === 0)
      return yield* new NothingToSelect({ detail: "The local Library contains no Skills" });
    query = yield* prompter
      .autocomplete("Select a collection", [
        ...collections.map((collection): { value: string; label: string } => ({
          value: collection.id,
          label: collection.label,
        })),
        { value: DONE, label: DONE },
      ])
      .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(DONE)));
    if (query === DONE) return;
  }

  const collection = view.collections.find((candidate) =>
    [candidate.id, candidate.label].includes(query),
  );
  const members = collection
    ? view.membersFor(
        collection.id,
        targets?.map((target) => target.scope),
      )
    : undefined;
  let wholeCollection = input.all;
  if (input.interactive && collection !== undefined && !wholeCollection) {
    const selectedMode = yield* prompter
      .select("What would you like to " + input.action + "?", [
        {
          value: "collection",
          label: input.enabled
            ? `Enable whole collection · ${descriptionLoadMessage(
                yield* view.descriptionLoad(collection.id),
              )}`
            : "Disable whole collection",
          hint: input.enabled
            ? "Include new skills and remove deleted ones when you update"
            : "Disable every skill in this collection",
        },
        ...(members?.length
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
    if (selectedMode === DONE) return;
    wholeCollection = selectedMode === "collection";
  }
  let selectedSkills: string[] | undefined;
  if (
    input.interactive &&
    !wholeCollection &&
    members &&
    (members.length > 1 || targets !== undefined)
  ) {
    selectedSkills = yield* prompter
      .multiselect(
        `Select Skills to ${input.action}`,
        members.map((skill) => ({
          value: skill.name,
          label: skill.name,
          ...(targets === undefined
            ? {}
            : {
                hint: targets
                  .filter((target) => target.skillIds.includes(skill.id))
                  .map(
                    (target) =>
                      `${collectionLabel(target.collectionId) ?? target.collectionId} · ${target.location}`,
                  )
                  .join(", "),
              }),
        })),
      )
      .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed([] as string[])));
    if (selectedSkills.length === 0) return;
  }
  // Disabling a whole Collection without a Scope asks which of its enabled Scopes.
  if (
    input.interactive &&
    !input.enabled &&
    wholeCollection &&
    collection !== undefined &&
    input.scope === undefined &&
    targets === undefined
  ) {
    const enabled = view.placements
      .map(withLocation)
      .filter((target) => target.collectionId === collection.id);
    if (!enabled.length) {
      yield* renderer.note("This collection is not enabled anywhere.", "Nothing to change");
      return;
    }
    const chosen =
      enabled.length === 1
        ? "0"
        : yield* prompter
            .autocomplete("Select where to disable Skills", [
              { value: "all", label: "All shown" },
              ...enabled.map((target, index) => ({ value: String(index), label: target.location })),
            ])
            .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(DONE)));
    if (chosen === DONE) return;
    targets = chosen === "all" ? enabled : [enabled[Number(chosen)]!];
  }
  if (targets === undefined) {
    let scope: Scope = input.scope ?? { kind: "global" };
    if (input.interactive && input.scope === undefined) {
      const choices = scopeChoices(input.cwd);
      if (choices.length > 1) {
        const chosen = yield* promptForScope(input.cwd, choices).pipe(
          Effect.catchTag("PromptCancelled", () => Effect.succeed(undefined)),
        );
        if (chosen === undefined) return;
        scope = chosen;
      }
    }
    targets = [{ collectionId: query, scope, skillIds: [], invocationBySkill: {}, location: "" }];
  }

  const intent: BindingChangeIntent = {
    subject: query,
    enabled: input.enabled,
    where: targets.map((target) => target.scope),
    ...(wholeCollection
      ? { members: "whole" as const }
      : selectedSkills === undefined
        ? {}
        : { members: selectedSkills }),
    allowDuplicate: input.allowDuplicate,
    invocation: input.invocation,
  };
  const outcomes = yield* renderer.withStatus(
    input.dryRun
      ? "Planning Collection Bindings"
      : input.enabled
        ? "Projecting retained Skills"
        : "Removing retained Projections",
    Effect.gen(function* () {
      const plan = yield* selection.preview(intent, input.configuration.inventory);
      return input.dryRun
        ? plan.changes.map((value) => ({ kind: "plan" as const, value }))
        : yield* applyBindingChanges(plan);
    }),
  );
  for (const outcome of outcomes) {
    if (input.enabled) {
      const warning = largeCollectionWarning(view.listingSizeAfter(outcome.value));
      if (warning !== undefined) yield* renderer.note(warning, "Skill listing");
    }
    yield* renderer.result(
      outcome.kind === "plan"
        ? input.enabled
          ? result("enablePlan", outcome.value)
          : result("disablePlan", outcome.value)
        : input.enabled
          ? // A copy left conflicted means the skill is not where agents look; say so in the status.
            result(
              "enable",
              outcome.value,
              outcome.value.projections.some((projection) => projection.status === "conflicted")
                ? 12
                : undefined,
            )
          : result("disable", outcome.value),
    );
  }
});

export const enableCliCommand = setEnabledCliCommand(true);
export const disableCliCommand = setEnabledCliCommand(false);
