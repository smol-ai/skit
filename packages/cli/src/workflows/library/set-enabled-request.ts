import {
  currentCollectionSkills,
  Enabled,
  enabledAt,
  enabledSkillIds,
  globalEnabled,
  type LibraryState,
  type SkillId,
  type InstallScope,
  type ManageApproval,
} from "@smolai/skit-core";
import { Effect, Schema } from "effect";
import { resolve } from "node:path";
import type { InvocationOption } from "../../invocation/policy.js";
import { OptionCombinationInvalid } from "../failures.js";
import { resolveLibrarySubject } from "./subject-resolution.js";

/** One enable or disable at one scope. */
export interface SetEnabledRequest {
  readonly query: string;
  readonly all?: boolean;
  readonly selectedSkills?: readonly string[];
  readonly scope: InstallScope;
  readonly enabled: boolean;
  readonly invocation?: InvocationOption;
  /** Setup changes only its explicitly selected subjects, preserving other installed copies. */
  readonly preserveUnselectedInstalledSkills?: boolean;
  readonly allowDuplicate?: boolean;
  /** Setup consent applies only to these exact symlinks, until installing succeeds. */
  readonly allowedDuplicateSymlinks?: readonly {
    readonly path: string;
    readonly canonicalPath: string;
    readonly dev: number;
    readonly ino: number;
    readonly linkTarget?: string;
  }[];
  readonly manage?: ManageApproval;
}

/** Binding policy only: no filesystem, storage, target discovery, or presentation. */
export const calculateSetEnabled = Effect.fn("SetEnabled.calculate")(function* (
  state: LibraryState,
  options: SetEnabledRequest,
) {
  if (options.invocation !== undefined && !options.enabled)
    return yield* new OptionCombinationInvalid({
      detail: "--invocation applies only when enabling a skill",
    });
  const subject = yield* resolveLibrarySubject(state, options.query);
  const collection = subject.kind === "collection" ? subject.collection : undefined;
  const skill = subject.kind === "skill" ? subject.skill : undefined;
  const members = subject.skills;
  if (options.all && collection === undefined)
    return yield* new OptionCombinationInvalid({
      detail: "--all requires a Collection, not one contained Skill",
    });
  if (options.all && options.selectedSkills !== undefined)
    return yield* new OptionCombinationInvalid({
      detail: "Choose either --all or selected Skills",
    });
  if (options.selectedSkills !== undefined && collection === undefined)
    return yield* new OptionCombinationInvalid({
      detail: "Selected Skills require a Collection",
    });
  if (
    !options.all &&
    options.selectedSkills === undefined &&
    collection !== undefined &&
    members.length !== 1
  )
    return yield* new OptionCombinationInvalid({
      detail: "Select a contained Skill or use --all for this Collection",
    });
  if (options.selectedSkills?.some((name) => !members.some((member) => member.name === name)))
    return yield* new OptionCombinationInvalid({
      detail: "Selected Skill is absent from this Collection",
    });
  const skills = [
    ...new Set(
      options.selectedSkills ??
        (options.all || collection !== undefined
          ? members.map((member) => member.name)
          : skill === undefined
            ? []
            : [skill.name]),
    ),
  ];
  const skillIdsByName = new Map(members.map((member) => [member.name, member.skill_id]));
  const skillIds = skills.flatMap((name) => skillIdsByName.get(name) ?? []);
  const scope = options.scope;
  const existing = enabledAt(state, scope);
  // A Skill subject still belongs to a Collection whose item may enable it.
  const ownerId = collection?.collection_id ?? skill?.collection_id;
  const collectionMembers = new Set<SkillId>(
    ownerId === undefined
      ? []
      : currentCollectionSkills(state, ownerId).map((member) => member.skill_id),
  );
  const followsCollection = (existing?.enabled ?? []).some(
    (item) => "collection" in item && item.collection === ownerId,
  );
  let items: Enabled[] = [...(existing?.enabled ?? [])];
  const withoutCollection = (list: Enabled[]) =>
    list.filter(
      (item) =>
        !("collection" in item && item.collection === ownerId) &&
        !("skill" in item && collectionMembers.has(item.skill)),
    );
  const hasSkill = (skillId: string) =>
    items.some((item) => "skill" in item && item.skill === skillId);
  if (options.all && collection !== undefined) {
    // A whole Collection follows its Source, so it replaces any of its individual items.
    items = withoutCollection(items);
    if (options.enabled) items.push({ collection: collection.collection_id });
    // A Skill gone from the Source is enabled only by its own item, which disabling ends too.
    else items = items.filter((item) => !("skill" in item && skillIds.includes(item.skill)));
  } else if (options.enabled) {
    for (const skillId of skillIds)
      if (!(followsCollection && collectionMembers.has(skillId)) && !hasSkill(skillId))
        items.push({ skill: skillId });
  } else {
    // Disabling one Skill of a followed Collection keeps its other current Skills individually.
    if (followsCollection && skillIds.some((skillId) => collectionMembers.has(skillId)))
      items = [
        ...withoutCollection(items),
        ...[...collectionMembers]
          .filter((skillId) => !skillIds.includes(skillId))
          .map((skillId) => ({ skill: skillId })),
      ];
    items = items.filter((item) => !("skill" in item && skillIds.includes(item.skill)));
  }
  const policies = { ...existing?.invocation_policies };
  for (const skillId of skillIds) {
    if (!options.enabled || options.invocation === "declared") delete policies[skillId];
    else if (options.invocation !== undefined) policies[skillId] = options.invocation;
  }
  const invocation_policies = Object.keys(policies).length ? policies : undefined;
  // The global list always exists, even empty: a failed disable leaves it empty until its copies
  // are removed, and a retry must still update them. A repository with no record before or after
  // has nothing to record.
  const hasList = existing !== undefined || items.length > 0;
  const changed =
    hasList &&
    (existing === undefined ||
      !Schema.toEquivalence(Schema.Array(Enabled))(existing.enabled, items) ||
      !Schema.toEquivalence(Schema.UndefinedOr(Schema.Record(Schema.String, Schema.String)))(
        existing.invocation_policies,
        invocation_policies,
      ));
  const existingIds = new Set(existing ? enabledSkillIds(state, existing.enabled) : []);
  const newlyEnabledSkills = options.enabled
    ? skills.filter((name) => {
        const id = skillIdsByName.get(name);
        return id !== undefined && !existingIds.has(id);
      })
    : [];
  return {
    plan: {
      subject_id: subject.subjectId,
      skills,
      scope,
      action: options.enabled ? ("enable" as const) : ("disable" as const),
      ...(options.invocation === undefined ? {} : { invocation: options.invocation }),
      changed,
      enabled: items,
      ...(invocation_policies === undefined ? {} : { invocation_policies }),
    },
    skillIds,
    newlyEnabledSkills,
    hasList,
  };
});

/** User intent, independent of the per-Scope requests needed to implement it. */
export interface SetEnabledIntent {
  readonly subject: string;
  readonly enabled: boolean;
  readonly members?: "whole" | readonly string[];
  readonly where: readonly InstallScope[] | "where-enabled";
  readonly invocation?: InvocationOption;
  readonly allowDuplicate?: boolean;
}

export interface EnabledCollection {
  readonly collectionId: string;
  readonly scope: InstallScope;
  readonly skillIds: readonly string[];
  readonly invocationBySkill: Readonly<Record<string, InvocationOption>>;
}

const scopeIdentity = (scope: InstallScope) =>
  scope.kind === "global" ? "global" : `repository:${resolve(scope.root)}`;

export const sameInstallScope = (left: InstallScope, right: InstallScope) =>
  scopeIdentity(left) === scopeIdentity(right);

export const uniqueInstallScopes = (scopes: readonly InstallScope[]) => [
  ...new Map(scopes.map((scope) => [scopeIdentity(scope), scope])).values(),
];

/** One Collection's enabled members and invocation intent at a scope, including empty follows. */
export const enabledCollections = (state: LibraryState): EnabledCollection[] =>
  [
    { scope: { kind: "global" as const }, ...globalEnabled(state) },
    ...state.repositories.map((repository) => ({
      ...repository,
      scope: { kind: "repository" as const, root: repository.root },
    })),
  ].flatMap((list) => {
    const ids = enabledSkillIds(state, list.enabled);
    const collections = new Set([
      ...state.skills
        .filter((skill) => ids.includes(skill.skill_id))
        .map((skill) => skill.collection_id),
      ...list.enabled.flatMap((item) => ("collection" in item ? [item.collection] : [])),
    ]);
    return [...collections].map((collectionId) => {
      const skillIds = state.skills
        .filter((skill) => skill.collection_id === collectionId && ids.includes(skill.skill_id))
        .map((skill) => skill.skill_id);
      return {
        collectionId,
        scope: list.scope,
        skillIds,
        invocationBySkill: Object.fromEntries(
          skillIds.map((id) => [id, list.invocation_policies?.[id] ?? "declared"]),
        ),
      };
    });
  });

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
