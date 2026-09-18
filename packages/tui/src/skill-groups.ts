import type { AuditSkillV1Alpha3 } from "../../cli/src/front-end";

type GroupableSkill = Pick<AuditSkillV1Alpha3, "provenance" | "canonicalLocation">;

export type SkillGroupIdentity =
  | { kind: "all" }
  | { kind: "collection"; ref: string }
  | { kind: "plugin"; ref: string }
  | { kind: "source"; name: string }
  | { kind: "unattributed" };

export type SkillGroup<T> = {
  identity: SkillGroupIdentity;
  label: string;
  skills: T[];
};

function identityFor(skill: GroupableSkill): SkillGroupIdentity {
  if (skill.provenance.collectionRef)
    return { kind: "collection", ref: skill.provenance.collectionRef };
  if (skill.provenance.parentPlugin) return { kind: "plugin", ref: skill.provenance.parentPlugin };
  if (skill.provenance.source) return { kind: "source", name: skill.provenance.source };
  return { kind: "unattributed" };
}

function provenancePriority(skill: GroupableSkill): number {
  if (skill.provenance.collectionRef) return 3;
  if (skill.provenance.parentPlugin) return 2;
  if (skill.provenance.source) return 1;
  return 0;
}

export function distinctSkills<T extends GroupableSkill>(skills: readonly T[]): T[] {
  const distinct = new Map<string, T>();
  for (const skill of skills) {
    const key = skill.canonicalLocation ?? `entry:${distinct.size}`;
    const current = distinct.get(key);
    if (!current || provenancePriority(skill) > provenancePriority(current))
      distinct.set(key, skill);
  }
  return [...distinct.values()];
}

function identityKey(identity: SkillGroupIdentity): string {
  switch (identity.kind) {
    case "all":
    case "unattributed":
      return identity.kind;
    case "collection":
    case "plugin":
      return `${identity.kind}:${identity.ref}`;
    case "source":
      return `${identity.kind}:${identity.name}`;
  }
}

function identityLabel(identity: SkillGroupIdentity): string {
  switch (identity.kind) {
    case "all":
      return "All skills";
    case "unattributed":
      return "Unattributed";
    case "collection":
    case "plugin":
      return identity.ref;
    case "source":
      return identity.name;
  }
}

function compareGroups<T>(left: SkillGroup<T>, right: SkillGroup<T>): number {
  const order: Record<SkillGroupIdentity["kind"], number> = {
    all: 0,
    collection: 1,
    plugin: 2,
    source: 3,
    unattributed: 4,
  };
  const kindOrder = order[left.identity.kind] - order[right.identity.kind];
  if (kindOrder) return kindOrder;
  return left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
}

export function groupSkills<T extends GroupableSkill>(skills: readonly T[]): SkillGroup<T>[] {
  const uniqueSkills = distinctSkills(skills);
  const grouped = new Map<string, SkillGroup<T>>();
  for (const skill of uniqueSkills) {
    const identity = identityFor(skill);
    const key = identityKey(identity);
    const group = grouped.get(key) ?? { identity, label: identityLabel(identity), skills: [] };
    group.skills.push(skill);
    grouped.set(key, group);
  }
  return [
    { identity: { kind: "all" }, label: "All skills", skills: uniqueSkills },
    ...[...grouped.values()].sort(compareGroups),
  ];
}

export function groupForSkill<T extends GroupableSkill>(
  groups: readonly SkillGroup<T>[],
  skill: T,
): SkillGroup<T> | undefined {
  if (skill.canonicalLocation) {
    const containing = groups.find(
      (group) =>
        group.identity.kind !== "all" &&
        group.skills.some((candidate) => candidate.canonicalLocation === skill.canonicalLocation),
    );
    if (containing) return containing;
  }
  const key = identityKey(identityFor(skill));
  return groups.find((group) => identityKey(group.identity) === key);
}

export function groupKindLabel(identity: SkillGroupIdentity): string {
  return identity.kind === "all" ? "all skills" : identity.kind;
}

export function groupLocation(identity: SkillGroupIdentity): string {
  switch (identity.kind) {
    case "all":
      return "All discovered Skills";
    case "unattributed":
      return "No collection or source provenance";
    case "collection":
      return identity.ref;
    case "plugin":
      return `Plugin ${identity.ref}`;
    case "source":
      return `Source ${identity.name}`;
  }
}
