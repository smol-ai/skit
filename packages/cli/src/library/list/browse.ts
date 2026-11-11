import { Block } from "../../terminal/blocks.js";
import { classifyFailure } from "../../commands/failure-classification.js";
import { skillMetadataFields, skillMetadataLines } from "../presentation/skill-metadata.js";
import { terminalData } from "../../terminal/text.js";
import { Effect } from "effect";
import { resolve } from "node:path";
import type { InvocationOption } from "@smolai/skit-core/library/session";
import { invocationEligibleScopes } from "@smolai/skit-core/library/session";
import {
  DESTINATION_QUESTION,
  destinationLabel,
  destinationValue,
  invocationChoices,
  invocationBriefing,
  invocationRowSummary,
  invocationExplanation,
  invocationQuestion,
  scopeRowLabel,
  fileChangeLabels,
} from "../presentation/invocation.js";
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
} from "@smolai/skit-core/library/session";
import { Prompter, PromptCancelled } from "../../terminal/prompter.js";
import { Renderer } from "../../terminal/renderer.js";
import { promptForScope } from "../presentation/scope-prompt.js";
import {
  collectionTitle,
  collectionChoiceTitle,
  collectionHint,
  collectionEnablement,
  collectionWarnings,
} from "../presentation/collection-source.js";

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

function pendingReview(pending: PendingLibraryChange): readonly Block[] {
  return pending.facts.map((fact, index) => {
    const policy = pending.policies[index] ?? pending.policies[0];
    return Block.Group({
      title: `${fact.action === "enable" ? "Enable" : "Disable"} ${fact.skills.join(", ")}`,
      children: [
        ...(fact.collectionLabel === undefined
          ? []
          : [
              Block.Note({ text: [collectionTitle(fact.collectionLabel, fact.collectionSource)] }),
              Block.Note({ text: [collectionHint(fact.collectionSource)] }),
            ]),
        ...(fact.wholeCollection
          ? [
              Block.Note({
                text: [
                  fact.action === "enable"
                    ? "The collection includes new skills and removes deleted ones when you update."
                    : "Every skill in the collection is disabled.",
                ],
              }),
            ]
          : []),
        Block.Fields({
          rows: [
            { label: "Applies to", value: destinationValue(fact.scope) },
            ...(fact.action === "enable" && policy
              ? [
                  { label: "Behaviour", value: [invocationRowSummary(policy)] },
                  { label: "Meaning", value: [invocationExplanation(policy)] },
                ]
              : []),
            { label: "Files", value: [fileChangeLabels[fact.fileChange]] },
          ],
        }),
      ],
    });
  });
}

const applyWithConfirmation = Effect.fn("CLI.libraryBrowse.apply")(function* (
  session: LibrarySessionState,
  progress: string,
) {
  const prompter = yield* Prompter;
  const renderer = yield* Renderer;
  const proposed = session.outcome;
  if (proposed === undefined) return session;
  if (proposed.kind === "failed") {
    yield* renderer.note(
      [Block.Status({ tone: "error", text: [classifyFailure(proposed.failure).message] })],
      "Unable to preview change",
    );
    return session;
  }
  if (proposed.kind === "unchanged") {
    yield* renderer.note(
      [Block.Note({ text: ["Already set this way. Nothing to change."] })],
      "No change",
    );
    return session;
  }
  if (proposed.kind !== "preview") return session;
  yield* renderer.note(pendingReview(proposed.pending), "Review");
  const confirmed = yield* prompter
    .confirm("Apply this change?")
    .pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(false)));
  if (!confirmed) {
    yield* renderer.note([Block.Note({ text: ["Nothing was written."] })], "Cancelled");
    return cancelLibraryChange(session);
  }
  const applied = yield* renderer.withStatus(progress, confirmLibraryChange(session));
  if (applied.outcome?.kind === "failed") {
    const failure = classifyFailure(applied.outcome.failure);
    yield* renderer.note(
      [
        Block.Status({ tone: "error", text: [failure.message] }),
        Block.Note({ text: [failure.remediation] }),
      ],
      "Unable to apply change",
    );
  } else {
    yield* renderer.note(
      proposed.pending.facts.map((fact) =>
        Block.Status({
          tone: "ok",
          text: [
            `${fact.action === "enable" ? "Enabled" : "Disabled"} (`,
            ...destinationValue(fact.scope),
            ")",
          ],
        }),
      ),
      "Applied",
    );
  }
  return applied;
});

const enableSkill = Effect.fn("CLI.libraryBrowse.enable")(function* (
  session: LibrarySessionState,
  row: LibrarySkillRow,
) {
  const scope = yield* promptForScope(resolve(process.cwd()));
  const proposed = yield* proposeLibraryEnable(session, row, { scope });
  return yield* applyWithConfirmation(proposed, "Installing skill");
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
  row: LibrarySkillRow,
) {
  const renderer = yield* Renderer;
  const eligible = invocationEligibleScopes(row);
  if (eligible.length === 0) {
    yield* renderer.note(
      [Block.Note({ text: ["Enable this skill before changing when it may be used."] })],
      "Not applicable",
    );
    return session;
  }
  const scopeRow = yield* chooseScope(DESTINATION_QUESTION, eligible);
  if (scopeRow.policy === undefined) return session;
  yield* renderer.note(invocationBriefing(scopeRow.policy), "Invocation");
  const invocation = yield* (yield* Prompter).autocomplete<InvocationOption>(
    invocationQuestion(scopeRow.policy),
    invocationChoices(scopeRow),
  );
  const proposed = yield* proposeLibraryInvocation(session, row, scopeRow, invocation);
  return yield* applyWithConfirmation(proposed, "Updating when this Skill may be used");
});

const disableSkill = Effect.fn("CLI.libraryBrowse.disable")(function* (
  session: LibrarySessionState,
  row: LibrarySkillRow,
) {
  const options = row.scopes.map((scopeRow, index) => ({
    value: String(index),
    label: scopeRowLabel(scopeRow),
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
  const proposed = yield* proposeLibraryDisable(session, row, scopes);
  return yield* applyWithConfirmation(proposed, "Removing installed skills");
});

/** Interactive Library browser backed by the portable enable and disable workflows. */
export const browseLibrary = Effect.fn("CLI.libraryBrowse")(function* (
  initial: LibrarySessionState,
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
          label: collectionChoiceTitle(row.heading, row.collectionSource),
          hint: [
            `${session.skills.filter((skill) => skill.collectionId === row.collectionId).length} Skills`,
            collectionEnablement(
              session.skills.filter((skill) => skill.collectionId === row.collectionId).length,
              session.skills.filter(
                (skill) => skill.collectionId === row.collectionId && skill.scopes.length > 0,
              ).length,
            ),
          ]
            .filter(Boolean)
            .join(" | "),
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
            label: row.scopes.length > 0 ? `${row.name} | enabled` : row.name,
            hint: skillMetadataLines(row).join(" | "),
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
              collectionId,
              skillId === ENABLE_COLLECTION,
              scopes,
            );
            return yield* applyWithConfirmation(
              proposed,
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
        const detail = terminalData(row);
        const body = [
          Block.Fields({
            rows: [
              {
                label: "Collection",
                value: [collectionTitle(detail.heading, detail.collectionSource)],
              },
              ...skillMetadataFields(detail),
              ...(detail.collectionSource?.authority
                ? [{ label: "Registry", value: [detail.collectionSource.authority] }]
                : []),
              ...(detail.scopes.length === 0 ? [{ label: "Enabled", value: ["No"] }] : []),
            ],
          }),
          ...detail.scopes.map((scopeRow) =>
            Block.Group({
              title: destinationLabel(scopeRow.scope),
              children: [
                Block.Fields({
                  rows: [
                    {
                      label: "Model invocation",
                      value: [
                        scopeRow.policy === undefined
                          ? "Unavailable"
                          : invocationRowSummary(scopeRow.policy),
                      ],
                    },
                  ],
                }),
              ],
            }),
          ),
          ...collectionWarnings(detail.collectionSource).map((warning) =>
            Block.Status({ tone: "warn", text: [warning] }),
          ),
          ...(detail.invocationFailure
            ? [
                Block.Status({
                  tone: "warn",
                  text: [
                    `Author preference unavailable: ${classifyFailure(detail.invocationFailure).message}`,
                  ],
                }),
              ]
            : []),
        ];
        yield* renderer.note(body, detail.name);
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
          session = yield* abandonOnCancel(enableSkill(session, row), session);
        else if (action === "disable")
          session = yield* abandonOnCancel(disableSkill(session, row), session);
        else session = yield* abandonOnCancel(changeInvocation(session, row), session);
      }
    }
  }
});
