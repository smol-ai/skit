import type { HarnessName as Harness } from "@smolai/skit-core";
import { Effect } from "effect";
import { resolve } from "node:path";
import type { InvocationOption } from "../invocation/policy.js";
import {
  DESTINATION_QUESTION,
  destinationLabel,
  harnessChoices,
  invocationChoices,
  invocationEligibleBindings,
  invocationBriefing,
  invocationRowSummary,
} from "../library/read-model.js";
import type { ProjectionOptions } from "../workflows/library/projection-options.js";
import {
  cancelLibraryChange,
  confirmLibraryChange,
  proposeLibraryDisable,
  proposeLibraryEnable,
  proposeLibraryInvocation,
  type LibraryBindingRow,
  type LibrarySessionState,
  type LibrarySkillRow,
  type PendingLibraryChange,
} from "../workflows/library/session.js";
import { Prompter, PromptCancelled } from "./prompter.js";
import { Renderer } from "./renderer.js";
import { promptForScope } from "./scope-prompt.js";

const DONE = "Done";
const BACK_TO_COLLECTIONS = "Back to collections";
const BACK_TO_SKILLS = "Back to skills";
const ALL_BINDINGS = "all";
type BrowseServices = Prompter | Renderer;

const abandonOnCancel = <E, R>(
  effect: Effect.Effect<LibrarySessionState, E | PromptCancelled, R>,
  state: LibrarySessionState,
) => effect.pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(state)));

function chooseHarness(
  candidates: readonly Harness[],
): Effect.Effect<Harness | undefined, PromptCancelled, BrowseServices> {
  return Effect.gen(function* () {
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    return yield* (yield* Prompter).autocomplete("Select a harness", harnessChoices(candidates));
  });
}

export function pendingReviewText(pending: PendingLibraryChange): string {
  return pending.facts
    .map((fact, index) => {
      const policy = pending.policies[index] ?? pending.policies[0];
      return [
        `  ${fact.action === "enable" ? "Enable" : "Disable"} ${fact.skills.join(", ")}`,
        `    agents     ${fact.harnessLabels.join(", ")}`,
        `    applies to ${fact.destination}`,
        ...(fact.action === "enable" && policy
          ? [
              `    behaviour  ${invocationRowSummary(policy)}`,
              `    meaning    ${policy.effectiveSummary}`,
            ]
          : []),
        `    writes     ${fact.writes}`,
      ].join("\n");
    })
    .join("\n\n");
}

const applyWithConfirmation = Effect.fn("CLI.libraryBrowse.apply")(function* (
  session: LibrarySessionState,
  configuration: ProjectionOptions,
  progress: string,
) {
  const prompter = yield* Prompter;
  const renderer = yield* Renderer;
  const proposed = session.outcome;
  if (proposed === undefined) return session;
  if (proposed.kind === "failed") {
    yield* renderer.note(proposed.failure.message, "Unable to preview change");
    return session;
  }
  if (proposed.kind !== "preview") return session;
  yield* renderer.note(pendingReviewText(proposed.pending), "Review");
  const confirmed = yield* prompter
    .confirm("Apply this change?")
    .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(false)));
  if (!confirmed) {
    yield* renderer.note("Nothing was written.", "Cancelled");
    return cancelLibraryChange(session);
  }
  const applied = yield* renderer.withStatus(
    progress,
    confirmLibraryChange(session, configuration),
  );
  if (applied.outcome?.kind === "failed")
    yield* renderer.note(
      `${applied.outcome.failure.message}\n${applied.outcome.failure.remediation}`,
      "Unable to apply change",
    );
  else
    yield* renderer.note(
      proposed.pending.facts
        .map(
          (fact) =>
            `${fact.action === "enable" ? "Enabled" : "Disabled"} for ${fact.harnessLabels.join(", ")} (${fact.destination})`,
        )
        .join("\n"),
      "Applied",
    );
  return applied;
});

const enableSkill = Effect.fn("CLI.libraryBrowse.enable")(function* (
  session: LibrarySessionState,
  configuration: ProjectionOptions,
  row: LibrarySkillRow,
) {
  const renderer = yield* Renderer;
  const harness = yield* chooseHarness(session.harnesses);
  if (harness === undefined) {
    yield* renderer.note(
      "No supported harnesses detected. Configure a harness, then try again.",
      "Not enabled",
    );
    return session;
  }
  const scope = yield* promptForScope(resolve(process.cwd()));
  const proposed = yield* proposeLibraryEnable(session, configuration, row, {
    harnesses: [harness],
    scope,
  });
  return yield* applyWithConfirmation(proposed, configuration, "Projecting Skill");
});

const chooseBinding = Effect.fn("CLI.libraryBrowse.chooseBinding")(function* (
  message: string,
  bindings: readonly LibraryBindingRow[],
) {
  if (bindings.length === 1) return bindings[0];
  const choice = yield* (yield* Prompter).autocomplete(
    message,
    bindings.map((binding, index) => ({
      value: String(index),
      label: destinationLabel(binding.scope),
      ...(binding.policy === undefined ? {} : { hint: invocationRowSummary(binding.policy) }),
    })),
  );
  const selected = bindings[Number(choice)];
  return selected === undefined ? yield* Effect.die(`Unknown Binding choice: ${choice}`) : selected;
});

const changeInvocation = Effect.fn("CLI.libraryBrowse.invocation")(function* (
  session: LibrarySessionState,
  configuration: ProjectionOptions,
  row: LibrarySkillRow,
) {
  const renderer = yield* Renderer;
  const eligible = invocationEligibleBindings(row);
  if (eligible.length === 0) {
    yield* renderer.note(
      "None of this Skill's current Bindings carries an invocation policy.",
      "Not applicable",
    );
    return session;
  }
  const binding = yield* chooseBinding(DESTINATION_QUESTION, eligible);
  if (binding.policy === undefined) return session;
  yield* renderer.note(invocationBriefing(binding.policy), binding.policy.harnessLabel);
  const invocation = yield* (yield* Prompter).autocomplete<InvocationOption>(
    binding.policy.question,
    invocationChoices(binding),
  );
  const proposed = yield* proposeLibraryInvocation(
    session,
    configuration,
    row,
    binding,
    invocation,
  );
  return yield* applyWithConfirmation(
    proposed,
    configuration,
    "Updating when this Skill may be used",
  );
});

const disableSkill = Effect.fn("CLI.libraryBrowse.disable")(function* (
  session: LibrarySessionState,
  configuration: ProjectionOptions,
  row: LibrarySkillRow,
) {
  const options = row.bindings.map((binding, index) => ({
    value: String(index),
    label: binding.label,
  }));
  const choice =
    options.length === 1
      ? "0"
      : yield* (yield* Prompter).autocomplete(DESTINATION_QUESTION, [
          { value: ALL_BINDINGS, label: "All shown" },
          ...options,
        ]);
  const selected = choice === ALL_BINDINGS ? row.bindings : [row.bindings[Number(choice)]];
  const bindings = selected.filter(
    (binding): binding is LibraryBindingRow => binding !== undefined,
  );
  const proposed = yield* proposeLibraryDisable(session, configuration, row, bindings);
  return yield* applyWithConfirmation(proposed, configuration, "Removing Projections");
});

/** Interactive Library browser backed by the portable enable and disable workflows. */
export const browseLibraryEffect = Effect.fn("CLI.libraryBrowse")(function* (
  initial: LibrarySessionState,
  configuration: ProjectionOptions,
) {
  const prompter = yield* Prompter;
  const renderer = yield* Renderer;
  let session = initial;
  while (session.skills.length > 0) {
    const collections = [...new Map(session.skills.map((row) => [row.collectionId, row])).values()];
    const collectionId = yield* prompter
      .autocomplete("Select a collection", [
        ...collections.map((row) => ({
          value: row.collectionId,
          label: row.heading,
          hint: `${session.skills.filter((skill) => skill.collectionId === row.collectionId).length} Skills`,
        })),
        { value: DONE, label: DONE },
      ])
      .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(DONE)));
    if (collectionId === DONE) return;
    while (true) {
      const rows = session.skills.filter((row) => row.collectionId === collectionId);
      const skillId = yield* prompter
        .autocomplete("Select a Skill", [
          ...rows.map((row) => ({
            value: row.skillVersionId,
            label: row.bindings.length > 0 ? `${row.name} · enabled` : row.name,
          })),
          { value: BACK_TO_COLLECTIONS, label: BACK_TO_COLLECTIONS },
        ])
        .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(BACK_TO_COLLECTIONS)));
      if (skillId === BACK_TO_COLLECTIONS) break;
      while (true) {
        const row = session.skills.find((candidate) => candidate.skillVersionId === skillId);
        if (row === undefined) break;
        yield* renderer.note(
          `${row.heading}\n  ${row.name}\n  ${row.bindings.length === 0 ? "not enabled" : row.bindings.map((binding) => binding.label).join("\n  ")}`,
          "Skill",
        );
        const action = yield* prompter
          .select<"enable" | "disable" | "invocation" | "back" | "done">("What next?", [
            { value: "enable", label: "Enable" },
            ...(row.bindings.length > 0 ? [{ value: "disable" as const, label: "Disable" }] : []),
            ...(invocationEligibleBindings(row).length > 0
              ? [{ value: "invocation" as const, label: "Change when it may be used" }]
              : []),
            { value: "back", label: BACK_TO_SKILLS },
            { value: "done", label: DONE },
          ])
          .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed("done" as const)));
        if (action === "done") return;
        if (action === "back") break;
        if (action === "enable")
          session = yield* abandonOnCancel(enableSkill(session, configuration, row), session);
        else if (action === "disable")
          session = yield* abandonOnCancel(disableSkill(session, configuration, row), session);
        else
          session = yield* abandonOnCancel(changeInvocation(session, configuration, row), session);
      }
    }
  }
});
