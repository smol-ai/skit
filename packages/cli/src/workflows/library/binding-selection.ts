import {
  BindingEntry,
  bindingSkillIds,
  currentCollectionSkills,
  DeviceBinding,
  RepositoryBinding,
  type LibraryState,
  type SkillId,
  type SkitBindingScope,
} from "@smolai/skit-core";
import { Effect, Schema } from "effect";
import { resolve } from "node:path";
import type { InvocationOption } from "../../invocation/policy.js";
import { OptionCombinationInvalid } from "../failures.js";
import { resolveLibrarySubject } from "./subject-resolution.js";

export interface BindingSelection {
  readonly query: string;
  readonly all?: boolean;
  readonly selectedSkills?: readonly string[];
  readonly scope: SkitBindingScope;
  readonly enabled: boolean;
  readonly invocation?: InvocationOption;
}

/** The one Binding at a Scope, if anything is enabled there. */
export const scopeBinding = (
  state: LibraryState,
  scope: SkitBindingScope,
): DeviceBinding | RepositoryBinding | undefined =>
  scope.kind === "global"
    ? state.global_bindings[0]
    : state.local_bindings.find((binding) => resolve(binding.scope.root) === resolve(scope.root));

/** Binding policy only: no filesystem, storage, target discovery, or presentation. */
export const calculateBindingChange = Effect.fn("LibraryBindings.calculate")(function* (
  state: LibraryState,
  options: BindingSelection,
) {
  if (options.invocation !== undefined && !options.enabled)
    return yield* new OptionCombinationInvalid({
      detail: "--invocation applies only when enabling a Projection",
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
  const existing = scopeBinding(state, scope);
  // A Skill subject still belongs to a Collection whose entry may enable it.
  const ownerId = collection?.collection_id ?? skill?.collection_id;
  const collectionMembers = new Set<SkillId>(
    ownerId === undefined
      ? []
      : currentCollectionSkills(state, ownerId).map((member) => member.skill_id),
  );
  const followsCollection = (existing?.entries ?? []).some(
    (entry) => entry.kind === "collection" && entry.collection_id === ownerId,
  );
  let entries: BindingEntry[] = [...(existing?.entries ?? [])];
  const withoutCollection = (items: BindingEntry[]) =>
    items.filter(
      (entry) =>
        !(entry.kind === "collection" && entry.collection_id === ownerId) &&
        !(entry.kind === "skill" && collectionMembers.has(entry.skill_id)),
    );
  const skillEntry = (skillId: SkillId): BindingEntry => ({ kind: "skill", skill_id: skillId });
  const hasSkill = (skillId: string) =>
    entries.some((entry) => entry.kind === "skill" && entry.skill_id === skillId);
  if (options.all && collection !== undefined) {
    // A whole Collection follows its Source, so it replaces any of its individual entries.
    entries = withoutCollection(entries);
    if (options.enabled)
      entries.push({ kind: "collection", collection_id: collection.collection_id });
    // A Skill gone from the Source is enabled only by its own entry, which disabling ends too.
    else
      entries = entries.filter(
        (entry) => !(entry.kind === "skill" && skillIds.includes(entry.skill_id)),
      );
  } else if (options.enabled) {
    for (const skillId of skillIds)
      if (!(followsCollection && collectionMembers.has(skillId)) && !hasSkill(skillId))
        entries.push(skillEntry(skillId));
  } else {
    // Disabling one Skill of a followed Collection keeps its other current Skills individually.
    if (followsCollection && skillIds.some((skillId) => collectionMembers.has(skillId)))
      entries = [
        ...withoutCollection(entries),
        ...[...collectionMembers]
          .filter((skillId) => !skillIds.includes(skillId))
          .map((skillId) => skillEntry(skillId)),
      ];
    entries = entries.filter(
      (entry) => !(entry.kind === "skill" && skillIds.includes(entry.skill_id)),
    );
  }
  const policies = { ...existing?.invocation_policies };
  for (const skillId of skillIds) {
    if (!options.enabled || options.invocation === "declared") delete policies[skillId];
    else if (options.invocation !== undefined) policies[skillId] = options.invocation;
  }
  const common = {
    entries,
    ...(Object.keys(policies).length ? { invocation_policies: policies } : {}),
  };
  const bindings: Array<DeviceBinding | RepositoryBinding> =
    existing === undefined && entries.length === 0
      ? []
      : [
          scope.kind === "global"
            ? { ...common, scope: { kind: "global" } }
            : { ...common, scope: { kind: "repository", root: scope.root } },
        ];
  const changed = bindings.some(
    (binding) =>
      existing === undefined ||
      !Schema.toEquivalence(Schema.Array(BindingEntry))(existing.entries, binding.entries) ||
      !Schema.toEquivalence(Schema.UndefinedOr(Schema.Record(Schema.String, Schema.String)))(
        existing.invocation_policies,
        binding.invocation_policies,
      ),
  );
  const existingIds = new Set(existing ? bindingSkillIds(state, existing) : []);
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
      enabled: options.enabled,
      ...(options.invocation === undefined ? {} : { invocation: options.invocation }),
      changed,
      bindings,
    },
    skillIds,
    newlyEnabledSkills,
  };
});

/** User intent, independent of the per-Scope requests needed to implement it. */
export interface BindingChangeIntent {
  readonly subject: string;
  readonly enabled: boolean;
  readonly members?: "whole" | readonly string[];
  readonly where: readonly SkitBindingScope[] | "where-enabled";
  readonly invocation?: InvocationOption;
  readonly allowDuplicate?: boolean;
}

export interface BindingPlacement {
  readonly collectionId: string;
  readonly scope: SkitBindingScope;
  readonly skillIds: readonly string[];
  readonly invocationBySkill: Readonly<Record<string, InvocationOption>>;
}

const scopeIdentity = (scope: SkitBindingScope) =>
  scope.kind === "global" ? "global" : `repository:${resolve(scope.root)}`;

export const sameBindingScope = (left: SkitBindingScope, right: SkitBindingScope) =>
  scopeIdentity(left) === scopeIdentity(right);

export const uniqueBindingScopes = (scopes: readonly SkitBindingScope[]) => [
  ...new Map(scopes.map((scope) => [scopeIdentity(scope), scope])).values(),
];

/** One Collection's enabled members and invocation intent at a Scope, including empty follows. */
export const bindingPlacements = (state: LibraryState): BindingPlacement[] =>
  [...state.global_bindings, ...state.local_bindings].flatMap((binding) => {
    const ids = bindingSkillIds(state, binding);
    const collections = new Set([
      ...state.skills
        .filter((skill) => ids.includes(skill.skill_id))
        .map((skill) => skill.collection_id),
      ...binding.entries.flatMap((entry) =>
        entry.kind === "collection" ? [entry.collection_id] : [],
      ),
    ]);
    return [...collections].map((collectionId) => {
      const skillIds = state.skills
        .filter((skill) => skill.collection_id === collectionId && ids.includes(skill.skill_id))
        .map((skill) => skill.skill_id);
      return {
        collectionId,
        scope: binding.scope,
        skillIds,
        invocationBySkill: Object.fromEntries(
          skillIds.map((id) => [id, binding.invocation_policies?.[id] ?? "declared"]),
        ),
      };
    });
  });

/** Expand once, filtering a multi-Scope disable to the members actually enabled at each Scope. */
export const expandBindingIntent = Effect.fn("LibraryBindings.expandIntent")(function* (
  state: LibraryState,
  intent: BindingChangeIntent,
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
  const scopes = uniqueBindingScopes(
    intent.where === "where-enabled"
      ? bindingPlacements(state)
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
      const binding = scopeBinding(state, scope);
      const enabled = new Set(binding === undefined ? [] : bindingSkillIds(state, binding));
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
