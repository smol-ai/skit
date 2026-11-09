import * as Library from "@smolai/skit-core/library";
import { MissingRequirement } from "../commands/input-failures.js";

import { type InstallScope } from "@smolai/skit-core/library";

import { Effect } from "effect";

import { NothingToSelect } from "../terminal/interaction-failures.js";

import { enableOutputContracts } from "./enable/output.js";

import { type InvocationOption, scopeChoices } from "@smolai/skit-core/library/session";
import {
  setEnabledOutcomes,
  SetEnabledIncomplete,
  type SetEnabledIntent,
  type EnabledCollection,
  sameInstallScope,
} from "@smolai/skit-core/library/enable";

import { Prompter } from "../terminal/prompter.js";
import { Renderer } from "../terminal/renderer.js";
import { promptForScope } from "./presentation/scope-prompt.js";
import { failureExitCodes } from "../commands/failure-classification.js";
import { encodeResult as result } from "../commands/encode-result.js";

import { largeCollectionWarning, descriptionLoadMessage } from "./presentation/description-size.js";
import { collectionChoiceTitle } from "./presentation/collection-source.js";

const DONE = "Done";

export interface SetEnabledCommandInput {
  readonly action: "enable" | "disable";
  readonly enabled: boolean;
  readonly subject?: string;
  readonly scope?: InstallScope;
  readonly cwd: string;
  readonly all: boolean;
  readonly allowDuplicate?: boolean;
  readonly invocation?: InvocationOption;
  readonly dryRun: boolean;
  readonly interactive: boolean;
}

type EnabledTarget = EnabledCollection & { readonly location: string };
const withLocation = (placement: EnabledCollection): EnabledTarget => ({
  ...placement,
  location: placement.scope.kind === "global" ? "global" : `repository ${placement.scope.root}`,
});

/** Native Collection binding path; interactive selection supplies names from retained membership. */
export const presentSetEnabled = Effect.fn("CLI.setEnabled.portable")(function* (
  input: SetEnabledCommandInput,
) {
  if (input.subject === undefined && !input.interactive)
    return yield* new MissingRequirement({
      command: input.action,
      requires: "a skill or collection",
      hint: "`skit list --json` lists them. Add `--global` or `--repo <path>` to choose the scope, and `--all` for a whole collection.",
    });
  const library = yield* Library.Service;
  const base = yield* library.read;
  const view = yield* library.list({ base });
  const prompter = yield* Prompter;
  const renderer = yield* Renderer;
  const collectionLabel = (collectionId: string) => {
    const collection = view.collections.find((collection) => collection.id === collectionId);
    return collection === undefined
      ? undefined
      : collectionChoiceTitle(collection.label, collection.collectionSource);
  };
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
    const enabled = view.placements
      .filter(
        (placement) => input.scope === undefined || sameInstallScope(placement.scope, input.scope),
      )
      .map(withLocation);
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
        ...collections.map((collection): { value: string; label: string; hint: string } => ({
          value: collection.id,
          label: collectionChoiceTitle(collection.label, collection.collectionSource),
          hint: [
            view.placements.some((placement) => placement.collectionId === collection.id)
              ? "Enabled"
              : "Disabled",
          ]
            .filter(Boolean)
            .join(" | "),
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
    ? collection.members.filter(
        (member) =>
          targets === undefined || targets.some((target) => target.skillIds.includes(member.id)),
      )
    : undefined;
  let wholeCollection = input.all;
  if (input.interactive && collection !== undefined && !wholeCollection) {
    const selectedMode = yield* prompter
      .select("What would you like to " + input.action + "?", [
        {
          value: "collection",
          label: input.enabled
            ? `Enable whole collection | ${descriptionLoadMessage(
                yield* library.descriptionLoad({ collection: collection.id }, { base }),
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
                      `${collectionLabel(target.collectionId) ?? target.collectionId} | ${target.location}`,
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
    let scope: InstallScope = input.scope ?? { kind: "global" };
    if (input.interactive && input.scope === undefined) {
      const choices = scopeChoices(input.cwd);
      if (choices.length > 1) {
        const chosen = yield* promptForScope(input.cwd, choices).pipe(
          Effect.catchTag("PromptCancelled", () => Effect.undefined),
        );
        if (chosen === undefined) return;
        scope = chosen;
      }
    }
    targets = [{ collectionId: query, scope, skillIds: [], invocationBySkill: {}, location: "" }];
  }

  const intent: SetEnabledIntent = {
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
  const plan = yield* library.planEnabled([intent], { base });
  const outcomes = yield* renderer.withStatus(
    input.dryRun
      ? "Planning Collection Bindings"
      : input.enabled
        ? "Installing skills"
        : "Removing installed skills",
    Effect.gen(function* () {
      return input.dryRun
        ? plan.changes.map((value) => ({ kind: "plan" as const, value }))
        : yield* library.apply({ _tag: "Apply", plan: plan.plan }).pipe(
            Effect.flatMap((outcome) => setEnabledOutcomes(outcome.result)),
            Effect.catchTag("Library.SetEnabledIncomplete", (failure) => Effect.succeed(failure)),
          );
    }),
  );
  const incomplete = outcomes instanceof SetEnabledIncomplete ? outcomes : undefined;
  const reported =
    outcomes instanceof SetEnabledIncomplete
      ? outcomes.results.map((value) => ({ kind: "applied" as const, value }))
      : outcomes;
  for (const outcome of reported) {
    const owner = view.collections.find(
      (candidate) =>
        candidate.id === outcome.value.subject_id ||
        candidate.members.some((member) => member.id === outcome.value.subject_id),
    );
    const identity =
      owner === undefined
        ? {}
        : { collection_label: owner.label, collection_source: owner.collectionSource };
    if (input.enabled) {
      const warning = largeCollectionWarning(
        plan.changes.find(
          (change) =>
            change.subject_id === outcome.value.subject_id &&
            sameInstallScope(change.scope, outcome.value.scope),
        )!.listingSize,
      );
      if (warning !== undefined) yield* renderer.note(warning, "Skill listing");
    }
    yield* renderer.result(
      outcome.kind === "plan"
        ? input.enabled
          ? result("enablePlan", enableOutputContracts.enablePlan, {
              ...outcome.value,
              ...identity,
            })
          : result("disablePlan", enableOutputContracts.disablePlan, {
              ...outcome.value,
              ...identity,
            })
        : input.enabled
          ? // Completion is decided by the application; the CLI maps its classification to an exit.
            result(
              "enable",
              enableOutputContracts.enable,
              { ...outcome.value, ...identity },
              outcome.value.application.status === "incomplete" && incomplete
                ? failureExitCodes[incomplete.code]
                : undefined,
            )
          : result(
              "disable",
              enableOutputContracts.disable,
              { ...outcome.value, ...identity },
              outcome.value.application.status === "incomplete" && incomplete
                ? failureExitCodes[incomplete.code]
                : undefined,
            ),
    );
  }
  // A later scope can refuse before accepting intent. Keep the earlier results and
  // report that refusal separately instead of mislabelling a completed scope.
  if (incomplete && !incomplete.results.some((value) => value.application.status === "incomplete"))
    return yield* incomplete;
});

export { enableOutputContracts } from "./enable/output.js";
export { renderSetEnabled } from "./enable/present.js";
