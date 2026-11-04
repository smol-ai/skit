import { enabledAt } from "../../enabled.js";
import { enabledSkillIds } from "../../library-contracts.js";
import { type LibraryState } from "../../library-state.js";
import { type InstallScope } from "../../../vocabulary.js";
import { type ManageApproval } from "../../../install/files.js";
import { Effect } from "effect";
import { Library } from "../../library.js";
import type { InvocationOption } from "./invocation-option.js";
import { OptionCombinationInvalid } from "../../../shared/input-failures.js";
import { resolveLibrarySubject } from "../../subject-resolution.js";

/** One enable or disable at one scope. */
export interface SetEnabledRequest {
  readonly query: string;
  readonly all?: boolean;
  readonly selectedSkills?: readonly string[];
  readonly scope: InstallScope;
  readonly enabled: boolean;
  readonly invocation?: InvocationOption;
  readonly allowDuplicate?: boolean;
  /** Setup consent applies only to these exact symlinks, until installing succeeds. */
  readonly allowedDuplicateSymlinks?: readonly {
    readonly path: string;
    readonly canonicalPath: string;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly linkTarget?: string;
  }[];
  readonly manage?: ManageApproval;
}

/** Legacy text/option compatibility. Binding policy is shared with the Library owner. */
export const calculateSetEnabled = Effect.fn("SetEnabled.calculate")(function* (
  state: LibraryState,
  options: SetEnabledRequest,
) {
  if (options.invocation !== undefined && !options.enabled)
    return yield* new OptionCombinationInvalid({
      detail: "--invocation applies only when enabling a skill",
    });
  const subject = yield* resolveLibrarySubject(state, options.query);
  return yield* Library.calculateEnabled(state, {
    ...options,
    subject:
      subject.kind === "collection"
        ? { _tag: "Collection", id: subject.collection.collection_id }
        : { _tag: "Skill", id: subject.skill.skill_id },
  }).pipe(
    Effect.catchTag("Library.InvalidIntent", (error) =>
      Effect.fail(new OptionCombinationInvalid({ detail: error.detail })),
    ),
  );
});

/** User intent, independent of the per-Scope requests needed to implement it. */
export interface SetEnabledIntent {
  readonly subject: string;
  readonly enabled: boolean;
  readonly members?: "whole" | readonly string[];
  readonly where: readonly InstallScope[] | "where-enabled";
  readonly invocation?: InvocationOption;
  readonly allowDuplicate?: boolean;
  /** What a setup review approved, and nothing else. */
  readonly setup?: Library.SetupApproval;
  /** The folder the user approved managing, as previewed. */
  readonly manage?: ManageApproval;
}

export interface EnabledCollection {
  readonly collectionId: string;
  readonly scope: InstallScope;
  readonly skillIds: readonly string[];
  readonly invocationBySkill: Readonly<Record<string, InvocationOption>>;
}

export const sameInstallScope = Library.sameInstallScope;
export const uniqueInstallScopes = Library.uniqueInstallScopes;
export const enabledCollections: (state: LibraryState) => EnabledCollection[] =
  Library.enabledCollections;

/** Expand once, filtering a multi-Scope disable to the members actually enabled at each Scope. */
export const expandSetEnabledIntent = Effect.fn("SetEnabled.expandIntent")(function* (
  state: LibraryState,
  intent: SetEnabledIntent,
) {
  const subject = yield* resolveLibrarySubject(state, intent.subject);
  const selectedNames =
    intent.members !== undefined && intent.members !== "whole" ? intent.members : undefined;
  if (selectedNames?.some((name) => !subject.skills.some((skill) => skill.name === name)))
    return yield* new OptionCombinationInvalid({
      detail: "Selected Skill is absent from this Collection",
    });
  const collectionId =
    subject.kind === "collection" ? subject.collection.collection_id : subject.skill.collection_id;
  const scopes = uniqueInstallScopes(
    intent.where === "where-enabled"
      ? enabledCollections(state)
          .filter(
            (placement) =>
              placement.collectionId === collectionId &&
              (subject.kind === "collection" ||
                placement.skillIds.includes(subject.skill.skill_id)),
          )
          .map((placement) => placement.scope)
      : intent.where,
  );
  return scopes.flatMap((scope) => {
    let names = selectedNames;
    if (
      !intent.enabled &&
      intent.members !== "whole" &&
      (scopes.length > 1 || intent.where === "where-enabled")
    ) {
      const atScope = enabledAt(state, scope);
      const enabled = new Set(atScope === undefined ? [] : enabledSkillIds(state, atScope.enabled));
      names = (names ?? subject.skills.map((skill) => skill.name)).filter((name) =>
        subject.skills.some((skill) => skill.name === name && enabled.has(skill.skill_id)),
      );
      if (!names.length) return [];
    }
    return [
      {
        query: intent.subject,
        scope,
        enabled: intent.enabled,
        all: intent.members === "whole",
        ...(subject.kind === "collection" && names !== undefined ? { selectedSkills: names } : {}),
        ...(intent.invocation === undefined ? {} : { invocation: intent.invocation }),
        ...(intent.allowDuplicate === undefined ? {} : { allowDuplicate: intent.allowDuplicate }),
      },
    ];
  });
});
