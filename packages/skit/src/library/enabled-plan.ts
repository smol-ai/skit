import { Effect, Schema, Data } from "effect";
import { currentCollectionSkills, enabledSkillIds, Enabled } from "./library-contracts.js";
import { enabledAt, globalEnabled, type LibraryState } from "./library-state.js";
import { CollectionId, SkillId } from "./entity-ids.js";
import { InstallScope, InvocationPolicy } from "../vocabulary.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { resolve } from "node:path";
export const Subject = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Skill"), id: SkillId }),
  Schema.Struct({ _tag: Schema.Literal("Collection"), id: CollectionId }),
]);
export type Subject = typeof Subject.Type;
export const Invocation = Schema.Union([Schema.Literal("declared"), InvocationPolicy]);
export type Invocation = typeof Invocation.Type;
/** What a setup review approved for one enable, and nothing else. */
export const SetupApproval = Schema.Struct({
  /** The exact links the user approved keeping beside SKIT's copy, as previewed. */
  approvedSymlinks: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      canonicalPath: Schema.String,
      dev: Schema.String,
      ino: Schema.String,
      linkTarget: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type SetupApproval = typeof SetupApproval.Type;
export const Intent = Schema.Struct({
  _tag: Schema.Literals(["Enable", "Disable"]),
  subject: Subject,
  members: Schema.optionalKey(Schema.Union([Schema.Literal("whole"), Schema.Array(SkillId)])),
  where: Schema.Union([Schema.Array(InstallScope), Schema.Literal("where-enabled")]),
  invocation: Schema.optionalKey(Invocation),
  allowDuplicate: Schema.optionalKey(Schema.Boolean),
  setup: Schema.optionalKey(SetupApproval),
});
export type Intent = typeof Intent.Type;
export interface Request {
  readonly subject: Subject;
  readonly all?: boolean;
  readonly selectedSkills?: readonly string[];
  readonly scope: InstallScope;
  readonly enabled: boolean;
  readonly invocation?: Invocation;
  readonly allowDuplicate?: boolean;
  readonly setup?: SetupApproval;
}
export class InvalidIntent
  extends Data.TaggedError("Library.InvalidIntent")<{ detail: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation = "Select retained Skills or Collections and preview again.";
  get message() {
    return this.detail;
  }
}
export const calculateEnabled = Effect.fn("SetEnabled.calculate")(function* (
  state: LibraryState,
  options: Request,
) {
  if (options.invocation !== undefined && !options.enabled)
    return yield* new InvalidIntent({
      detail: "--invocation applies only when enabling a skill",
    });
  const collection =
    options.subject._tag === "Collection"
      ? state.collections.find((item) => item.collection_id === options.subject.id)
      : undefined;
  const skill =
    options.subject._tag === "Skill"
      ? state.skills.find((item) => item.skill_id === options.subject.id)
      : undefined;
  if (!collection && !skill)
    return yield* new InvalidIntent({ detail: "Selected subject is absent from this Library" });
  const members = skill
    ? [skill]
    : state.skills.filter((item) => item.collection_id === collection?.collection_id);
  const subjectId = options.subject.id;
  if (options.all && collection === undefined)
    return yield* new InvalidIntent({
      detail: "--all requires a Collection, not one contained Skill",
    });
  if (options.all && options.selectedSkills !== undefined)
    return yield* new InvalidIntent({
      detail: "Choose either --all or selected Skills",
    });
  if (options.selectedSkills !== undefined && collection === undefined)
    return yield* new InvalidIntent({
      detail: "Selected Skills require a Collection",
    });
  if (
    !options.all &&
    options.selectedSkills === undefined &&
    collection !== undefined &&
    members.length !== 1
  )
    return yield* new InvalidIntent({
      detail: "Select a contained Skill or use --all for this Collection",
    });
  if (options.selectedSkills?.some((name) => !members.some((member) => member.name === name)))
    return yield* new InvalidIntent({
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
      subject_id: subjectId,
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

export interface EnabledCollection {
  readonly collectionId: string;
  readonly scope: InstallScope;
  readonly skillIds: readonly string[];
  readonly invocationBySkill: Readonly<Record<string, Invocation>>;
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

export const expandIntent = Effect.fn("Library.expandIntent")(function* (
  state: LibraryState,
  intent: Intent,
) {
  const subject = intent.subject;
  const skills = state.skills.filter((skill) =>
    subject._tag === "Skill" ? skill.skill_id === subject.id : skill.collection_id === subject.id,
  );
  const collectionId = subject._tag === "Collection" ? subject.id : skills[0]?.collection_id;
  const ids =
    intent.members === undefined || intent.members === "whole" ? undefined : intent.members;
  if (ids?.some((id) => !skills.some((skill) => skill.skill_id === id)))
    return yield* new InvalidIntent({ detail: "Selected Skill is absent from this Collection" });
  const scopes = uniqueInstallScopes(
    intent.where === "where-enabled"
      ? enabledCollections(state)
          .filter(
            (p) =>
              p.collectionId === collectionId &&
              (subject._tag === "Collection" || p.skillIds.includes(subject.id)),
          )
          .map((p) => p.scope)
      : intent.where,
  );
  return scopes.flatMap((scope): Request[] => {
    let names = ids?.flatMap((id) =>
      skills.filter((skill) => skill.skill_id === id).map((skill) => skill.name),
    );
    if (
      intent._tag === "Disable" &&
      intent.members !== "whole" &&
      (scopes.length > 1 || intent.where === "where-enabled")
    ) {
      const list = enabledAt(state, scope);
      const enabled = new Set(list === undefined ? [] : enabledSkillIds(state, list.enabled));
      names = (names ?? skills.map((skill) => skill.name)).filter((name) =>
        skills.some((skill) => skill.name === name && enabled.has(skill.skill_id)),
      );
      if (!names.length) return [];
    }
    return [
      {
        subject,
        scope,
        enabled: intent._tag === "Enable",
        all: intent.members === "whole",
        ...(subject._tag === "Collection" && names !== undefined ? { selectedSkills: names } : {}),
        ...(intent.invocation === undefined ? {} : { invocation: intent.invocation }),
        ...(intent.allowDuplicate === undefined ? {} : { allowDuplicate: intent.allowDuplicate }),
        ...(intent.setup === undefined ? {} : { setup: intent.setup }),
      },
    ];
  });
});
