import {
  skillMetadataLines,
  metadataSource,
  metadataRevision,
  metadataDate,
} from "./skill-metadata.js";
import { terminalColors } from "./terminal-style.js";
import { Effect } from "effect";
import { resolve } from "node:path";
import type { InvocationOption } from "../invocation/policy.js";
import {
  DESTINATION_QUESTION,
  destinationLabel,
  invocationChoices,
  invocationEligibleScopes,
  invocationBriefing,
  invocationRowSummary,
} from "../library-application/read-model.js";
import type { InstalledSkillOptions } from "../workflows/library/installed-skill-options.js";
import {
  cancelLibraryChange,
  confirmLibraryChange,
  proposeLibraryDisable,
  proposeLibraryEnable,
  proposeLibraryCollectionChange,
  libraryCollectionScopes,
  proposeLibraryInvocation,
  type ScopeRow,
  type LibrarySessionState,
  type LibrarySkillRow,
  type PendingLibraryChange,
} from "../library-application/session.js";
import { Prompter, PromptCancelled } from "./prompter.js";
import { Renderer } from "./renderer.js";
import { promptForScope } from "./scope-prompt.js";

const DONE = "Done";
const BACK_TO_COLLECTIONS = "Back to collections";
const BACK_TO_SKILLS = "Back to skills";
const ALL_SCOPES = "all";
const ENABLE_COLLECTION = "Enable whole collection";
const DISABLE_COLLECTION = "Disable whole collection";

const abandonOnCancel = <E, R>(
  effect: Effect.Effect<LibrarySessionState, E | PromptCancelled, R>,
  state: LibrarySessionState,
) => effect.pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(state)));

export function pendingReviewText(pending: PendingLibraryChange): string {
  return pending.facts
    .map((fact, index) => {
      const policy = pending.policies[index] ?? pending.policies[0];
      return [
        `  ${fact.action === "enable" ? "Enable" : "Disable"} ${fact.skills.join(", ")}`,
        ...(fact.wholeCollection
          ? [
              fact.action === "enable"
                ? "    collection includes new skills and removes deleted ones when you update"
                : "    collection every skill is disabled",
            ]
          : []),
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
  configuration: InstalledSkillOptions,
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
  if (proposed.kind === "unchanged") {
    yield* renderer.note("Already set this way. Nothing to change.", "No change");
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
  const applied = yield* renderer.withStatus(progress, confirmLibraryChange(session));
  if (applied.outcome?.kind === "failed")
    yield* renderer.note(
      `${applied.outcome.failure.message}\n${applied.outcome.failure.remediation}`,
      "Unable to apply change",
    );
  else
    yield* renderer.note(
      proposed.pending.facts
        .map((fact) => `${fact.action === "enable" ? "Enabled" : "Disabled"} (${fact.destination})`)
        .join("\n"),
      "Applied",
    );
  return applied;
});

const enableSkill = Effect.fn("CLI.libraryBrowse.enable")(function* (
  session: LibrarySessionState,
  configuration: InstalledSkillOptions,
  row: LibrarySkillRow,
) {
  const scope = yield* promptForScope(resolve(process.cwd()));
  const proposed = yield* proposeLibraryEnable(session, configuration, row, { scope });
  return yield* applyWithConfirmation(proposed, configuration, "Projecting Skill");
});

const chooseScope = Effect.fn("CLI.libraryBrowse.chooseScope")(function* (
  message: string,
  scopes: readonly ScopeRow[],
) {
  if (scopes.length === 1) return scopes[0];
  const choice = yield* (yield* Prompter).autocomplete(
    message,
    scopes.map((scopeRow, index) => ({
      value: String(index),
      label: destinationLabel(scopeRow.scope),
      ...(scopeRow.policy === undefined ? {} : { hint: invocationRowSummary(scopeRow.policy) }),
    })),
  );
  const selected = scopes[Number(choice)];
  return selected === undefined ? yield* Effect.die(`Unknown scope choice: ${choice}`) : selected;
});

const changeInvocation = Effect.fn("CLI.libraryBrowse.invocation")(function* (
  session: LibrarySessionState,
  configuration: InstalledSkillOptions,
  row: LibrarySkillRow,
) {
  const renderer = yield* Renderer;
  const eligible = invocationEligibleScopes(row);
  if (eligible.length === 0) {
    yield* renderer.note(
      "None of this Skill's current Bindings carries an invocation policy.",
      "Not applicable",
    );
    return session;
  }
  const scopeRow = yield* chooseScope(DESTINATION_QUESTION, eligible);
  if (scopeRow.policy === undefined) return session;
  yield* renderer.note(invocationBriefing(scopeRow.policy), "Invocation");
  const invocation = yield* (yield* Prompter).autocomplete<InvocationOption>(
    scopeRow.policy.question,
    invocationChoices(scopeRow),
  );
  const proposed = yield* proposeLibraryInvocation(
    session,
    configuration,
    row,
    scopeRow,
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
  configuration: InstalledSkillOptions,
  row: LibrarySkillRow,
) {
  const options = row.scopes.map((scopeRow, index) => ({
    value: String(index),
    label: scopeRow.label,
  }));
  const choice =
    options.length === 1
      ? "0"
      : yield* (yield* Prompter).autocomplete(DESTINATION_QUESTION, [
          { value: ALL_SCOPES, label: "All shown" },
          ...options,
        ]);
  const selected = choice === ALL_SCOPES ? row.scopes : [row.scopes[Number(choice)]];
  const scopes = selected.filter((scopeRow): scopeRow is ScopeRow => scopeRow !== undefined);
  const proposed = yield* proposeLibraryDisable(session, configuration, row, scopes);
  return yield* applyWithConfirmation(proposed, configuration, "Removing installed skills");
});

/** Interactive Library browser backed by the portable enable and disable workflows. */
export const browseLibrary = Effect.fn("CLI.libraryBrowse")(function* (
  initial: LibrarySessionState,
  configuration: InstalledSkillOptions,
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
          {
            value: ENABLE_COLLECTION,
            label: ENABLE_COLLECTION,
            hint: "Include new skills and remove deleted ones when you update",
          },
          ...(libraryCollectionScopes(session, collectionId).length
            ? [
                {
                  value: DISABLE_COLLECTION,
                  label: DISABLE_COLLECTION,
                  hint: "Disable every skill in this collection",
                },
              ]
            : []),
          ...rows.map((row) => ({
            value: row.skillVersionId,
            label: row.scopes.length > 0 ? `${row.name} · enabled` : row.name,
            hint: `${metadataSource(row.source)} · revision ${metadataRevision(row.revision)} · source updated ${metadataDate(row.source_updated_at)}`,
          })),
          { value: BACK_TO_COLLECTIONS, label: BACK_TO_COLLECTIONS },
        ])
        .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(BACK_TO_COLLECTIONS)));
      if (skillId === BACK_TO_COLLECTIONS) break;
      if (skillId === ENABLE_COLLECTION || skillId === DISABLE_COLLECTION) {
        session = yield* abandonOnCancel(
          Effect.gen(function* () {
            const enabledScopes = libraryCollectionScopes(session, collectionId);
            const choice =
              skillId === ENABLE_COLLECTION
                ? undefined
                : enabledScopes.length === 1
                  ? "0"
                  : yield* prompter.autocomplete(DESTINATION_QUESTION, [
                      { value: ALL_SCOPES, label: "All shown" },
                      ...enabledScopes.map((scope, index) => ({
                        value: String(index),
                        label: destinationLabel(scope),
                      })),
                    ]);
            const scopes =
              skillId === ENABLE_COLLECTION
                ? [yield* promptForScope(resolve(process.cwd()))]
                : choice === ALL_SCOPES
                  ? enabledScopes
                  : [enabledScopes[Number(choice)]!];
            const proposed = yield* proposeLibraryCollectionChange(
              session,
              configuration,
              collectionId,
              skillId === ENABLE_COLLECTION,
              scopes,
            );
            return yield* applyWithConfirmation(
              proposed,
              configuration,
              "Updating the Collection's installed skills",
            );
          }),
          session,
        );
        continue;
      }
      while (true) {
        const row = session.skills.find((candidate) => candidate.skillVersionId === skillId);
        if (row === undefined) break;
        yield* renderer.note(
          [
            terminalColors().cyan(row.heading),
            `  ${terminalColors().bold(row.name)}`,
            ...skillMetadataLines(row).map((line) => `    ${terminalColors().dim(line)}`),
            ...(row.invocationWarning ? [`    ${row.invocationWarning}`] : []),
            `  ${row.scopes.length === 0 ? "not enabled" : row.scopes.map((scopeRow) => scopeRow.label).join("\n  ")}`,
          ].join("\n"),
          "Skill",
        );
        const action = yield* prompter
          .select<"enable" | "disable" | "invocation" | "back" | "done">("What next?", [
            { value: "enable", label: "Enable" },
            ...(row.scopes.length > 0 ? [{ value: "disable" as const, label: "Disable" }] : []),
            ...(invocationEligibleScopes(row).length > 0
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
