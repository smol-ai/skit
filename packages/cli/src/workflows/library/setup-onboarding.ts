import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import {
  SourceIdentity,
  sourceIdentityFromSource,
  type HarnessName as Harness,
  pathIsWithin,
} from "@smolai/skit-core";
import {
  indexSetupOnboardingEvidence,
  lockEvidenceKey,
  type SetupOnboardingEvidence,
  type SetupRetainedEvidence,
} from "./setup-evidence.js";
import type { SetupLockMatch } from "./setup-contract.js";
import { setupLockCollection, setupLockGroupKey } from "./skills-sh-lock-source.js";
import type { SetupOnboardingCandidate, SetupSkillInstance } from "./setup-contract.js";

export const classifyObservedOwner = (input: {
  readonly canonicalPath: string;
  readonly home: string;
  readonly harnesses: readonly Harness[];
  readonly repository?: string;
  readonly locks?: readonly SetupLockMatch[];
}): SetupSkillInstance["owner"] => {
  const agreeingLock = input.locks?.find((lock) => lock.content === "agrees");
  if (agreeingLock) return { kind: "skills-sh", source: agreeingLock.entry.source };
  if (input.repository) return { kind: "repository", repository: input.repository };
  if (input.harnesses.includes("codex")) {
    const codexHome = join(resolve(input.home), ".codex");
    if (pathIsWithin(join(codexHome, "skills", ".system"), input.canonicalPath))
      return { kind: "harness", harness: "codex", source: "Codex system", bundled: true };
    const pluginCache = join(codexHome, "plugins", "cache");
    if (pathIsWithin(join(pluginCache, "openai-bundled"), input.canonicalPath))
      return { kind: "harness", harness: "codex", source: "Codex bundled", bundled: true };
    if (pathIsWithin(join(pluginCache, "openai-primary-runtime"), input.canonicalPath))
      return { kind: "harness", harness: "codex", source: "Codex runtime", bundled: false };
    if (pathIsWithin(join(pluginCache, "openai-curated-remote"), input.canonicalPath))
      return { kind: "harness", harness: "codex", source: "Codex curated", bundled: false };
  }
  return { kind: "unknown" };
};

export const isSetupCandidateFromCodex = (paths: readonly string[], home = homedir()): boolean =>
  paths.some((path) => pathIsWithin(join(resolve(home), ".codex"), resolve(path)));

type LockImport = Omit<
  Extract<SetupOnboardingCandidate, { action: "import-observed-collection" }>,
  "name" | "owner"
>;
type LockDecision =
  | { readonly _tag: "Importable"; readonly imports: readonly LockImport[] }
  | { readonly _tag: "AlreadyRetained" | "Contested" | "NoClaim" };

/** Any import wins; otherwise retained wins over contested, then ordinary classification. */
const classifyLockClaims = (
  group: readonly SetupSkillInstance[],
  locks: readonly (readonly [string, SetupLockMatch])[],
  evidence: SetupOnboardingEvidence,
): LockDecision => {
  let decision: LockDecision = { _tag: "NoClaim" };
  const imports: LockImport[] = [];
  for (const [groupKey, lock] of locks) {
    const claim = evidence.lockClaims.get(groupKey);
    if (claim?._tag !== "Resolved") {
      if (claim?._tag === "Contested" && decision._tag === "NoClaim")
        decision = { _tag: "Contested" };
      continue;
    }
    const observedInstances = group.filter((instance) =>
      instance.locks.some((candidate) => setupLockGroupKey(candidate) === groupKey),
    );
    let matchingCollections: Set<string> | undefined;
    for (const instance of observedInstances) {
      const observedHash = instance.contentIdentity.observedHash;
      const matchingLock = instance.locks.find((item) => setupLockGroupKey(item) === groupKey);
      if (observedHash === undefined || matchingLock === undefined) {
        matchingCollections = new Set();
        break;
      }
      const key = lockEvidenceKey(
        matchingLock.lockPath,
        matchingLock.lockContentHash,
        instance.name,
        matchingLock.entry.skillPath,
        observedHash,
      );
      const collections = evidence.retainedByLockEvidence.get(key) ?? new Set<string>();
      matchingCollections =
        matchingCollections === undefined
          ? collections
          : new Set([...matchingCollections].filter((collection) => collections.has(collection)));
    }
    if ((matchingCollections?.size ?? 0) > 0) {
      decision = { _tag: "AlreadyRetained" };
      continue;
    }
    imports.push({
      paths: observedInstances.map((instance) => instance.path).sort(),
      action: "import-observed-collection",
      groupKey,
      source: lock.entry.source,
      lockContentHash: lock.lockContentHash,
      contentAgreement: lock.content,
      ...(lock.entry.skillPath ? { skillPath: lock.entry.skillPath } : {}),
    });
  }
  return imports.length ? { _tag: "Importable", imports } : decision;
};

/** Match copies only within the same repository or global installation scope. */
export const setupInstanceGroupKey = (instance: SetupSkillInstance): string => {
  const scope = instance.git.repository
    ? `repository:${instance.git.repository}`
    : instance.scope === "global"
      ? "global"
      : `standalone:${instance.path}`;
  return `${scope}\0${instance.name}`;
};

export const classifySetupOnboarding = (
  instances: ReadonlyArray<SetupSkillInstance>,
  retained?: SetupRetainedEvidence,
): SetupOnboardingCandidate[] => {
  const evidence = indexSetupOnboardingEvidence(instances, retained);
  const collections = retained?.library?.collections ?? [];
  const skills = retained?.library?.skills ?? [];
  const groups = new Map<string, SetupSkillInstance[]>();
  for (const instance of instances) {
    if (
      instance.owner.kind === "skit" ||
      instance.owner.kind === "authored" ||
      instance.owner.kind === "pnpm"
    )
      continue;
    const key = setupInstanceGroupKey(instance);
    groups.set(key, [...(groups.get(key) ?? []), instance]);
  }
  const candidates: SetupOnboardingCandidate[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) continue;
    const name = first.name;
    const paths = group.map((instance) => instance.path).sort();
    const owner = first.owner;
    const base = { name, paths, owner };
    if (group.some((instance) => instance.owner.kind === "invalid-marker")) {
      candidates.push({
        ...base,
        action: "blocked",
        reason: "invalid-ownership-marker",
      });
      continue;
    }
    if (owner.kind === "harness") {
      candidates.push({
        ...base,
        action: "harness-owned",
      });
      continue;
    }
    const hashes = new Set(
      group.flatMap((instance) =>
        instance.contentIdentity.observedHash ? [instance.contentIdentity.observedHash] : [],
      ),
    );
    if (hashes.size > 1) {
      candidates.push({
        ...base,
        action: "blocked",
        reason: "divergent-copies",
      });
      continue;
    }
    const groupLocks = group.flatMap((instance) => instance.locks);
    const importableLocks = [
      ...new Map(
        groupLocks.flatMap((lock) => {
          const groupKey = setupLockGroupKey(lock);
          return groupKey ? [[groupKey, lock] as const] : [];
        }),
      ).entries(),
    ];
    const lockDecision: LockDecision =
      hashes.size === 1
        ? classifyLockClaims(group, importableLocks, evidence)
        : { _tag: "NoClaim" };
    switch (lockDecision._tag) {
      case "Importable":
        candidates.push(...lockDecision.imports.map((selection) => ({ ...base, ...selection })));
        continue;
      case "AlreadyRetained":
        continue;
      case "Contested":
        candidates.push({ ...base, action: "blocked", reason: "contested-lock-claim" });
        continue;
      case "NoClaim":
        break;
      default:
        lockDecision satisfies never;
    }
    const matches = group.flatMap((instance) => instance.contentIdentity.libraryMatches);
    const uniqueMatches = [
      ...new Map(
        matches.map((match) => [`${match.subjectId}\0${match.skillVersionId}`, match]),
      ).values(),
    ];
    if (
      uniqueMatches.length > 1 ||
      group.some((instance) => instance.contentIdentity.status === "ambiguous")
    ) {
      candidates.push({
        ...base,
        action: "blocked",
        reason: "ambiguous-library-match",
      });
      continue;
    }
    const match = uniqueMatches[0];
    if (match !== undefined) {
      if (match.name !== name) {
        candidates.push({
          ...base,
          action: "blocked",
          reason: "library-skill-name-mismatch",
        });
        continue;
      }
      if (group.some((instance) => instance.git.repository !== undefined)) {
        if (
          importableLocks.some(([, lock]) => {
            const source = setupLockCollection(lock)?.source;
            const retainedSkill = skills.find(
              (skill) =>
                skill.skill_id === match.subjectId || skill.collection_id === match.subjectId,
            );
            const retainedSource =
              retainedSkill === undefined
                ? undefined
                : collections.findLast(
                    (collection) => collection.collection_id === retainedSkill.collection_id,
                  )?.upstream?.source_identity;
            if (source === undefined || retainedSource === undefined) return false;
            const lockSource = sourceIdentityFromSource(source, retained?.machineId);
            if (lockSource === undefined) return false;
            // Pre-v5 state recorded a well-known Source without a member selection as `url`.
            const legacyUrl =
              (lockSource.kind === "well-known" &&
                retainedSource.kind === "url" &&
                lockSource.locator.value === retainedSource.url.value) ||
              (lockSource.kind === "url" &&
                retainedSource.kind === "well-known" &&
                lockSource.url.value === retainedSource.locator.value);
            return legacyUrl || Schema.toEquivalence(SourceIdentity)(lockSource, retainedSource);
          })
        )
          continue;
        candidates.push({
          ...base,
          action: "repository-owned",
        });
        continue;
      }
      candidates.push({
        ...base,
        action: "bind-existing-entry",
        subjectId: match.subjectId,
        skillVersionId: match.skillVersionId,
        ...(() => {
          const matchedSkill = skills.find(
            (skill) =>
              skill.skill_id === match.subjectId || skill.collection_id === match.subjectId,
          );
          const label =
            matchedSkill === undefined
              ? undefined
              : collections.findLast(
                  (collection) => collection.collection_id === matchedSkill.collection_id,
                )?.label;
          return label === undefined ? {} : { collectionDisplayName: label };
        })(),
      });
      continue;
    }
    if (group.some((instance) => instance.git.repository !== undefined)) {
      candidates.push({
        ...base,
        action: "repository-owned",
      });
      continue;
    }
    if (group.some((instance) => instance.contentIdentity.status === "unhashable")) {
      candidates.push({
        ...base,
        action: "blocked",
        reason: "content-unhashable",
      });
      continue;
    }
    const projectionTargets = group.filter(
      (instance) => instance.scope === "global" && instance.harnesses.length > 0,
    );
    if (projectionTargets.length === group.length && hashes.size === 1) {
      candidates.push({
        ...base,
        action: "manage-locally",
        ...(paths.length === 1
          ? { sourceSelection: "automatic" as const, sourcePath: first.path }
          : { sourceSelection: "required" as const }),
      });
      continue;
    }
    candidates.push({
      ...base,
      action: "leave-alone",
    });
  }
  return candidates.sort((left, right) =>
    `${left.name}\0${left.paths[0] ?? ""}`.localeCompare(`${right.name}\0${right.paths[0] ?? ""}`),
  );
};
