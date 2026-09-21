import { createHash } from "node:crypto";
import { Effect, FileSystem, Schema } from "effect";
import {
  retainObservedCollectionEffect,
  LibraryStore,
  sourceLocator,
  type MachineId,
  type SkillsShProvenanceObservation,
} from "@smolai/skit-core";
import type { RetentionOptions } from "./retention-options.js";
import { setupLockGroupKey, type SetupOptions } from "./setup.js";
import {
  SetupKnownSourceSelection,
  type SetupLockMatch,
  type SetupResult,
} from "./setup-contract.js";
import { resolveSkillsShSelectedSource } from "./skills-sh-lock-source.js";

export class SetupObservedCollectionInvalid extends Schema.TaggedError<SetupObservedCollectionInvalid>()(
  "SetupObservedCollectionInvalid",
  {
    name: Schema.String,
    reason: Schema.Literals([
      "duplicate-selection",
      "candidate-not-found",
      "candidate-not-importable",
      "machine-identity-missing",
      "observation-missing",
      "contested-observation",
      "source-unresolvable",
      "lock-changed",
      "retention-missing",
    ]),
  },
) {}

export interface SetupObservedCollectionOptions {
  readonly setup: SetupOptions;
  readonly retention: Pick<RetentionOptions, "originalsPath">;
}

const samePaths = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((path) => right.includes(path));

const retainedSkillPath = (lockPath: string | undefined, name: string) => {
  if (!lockPath) return name;
  const normalized = lockPath.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.endsWith("/SKILL.md") ? normalized.slice(0, -"/SKILL.md".length) : normalized;
};

const observationFor = (
  lock: SetupLockMatch,
  machineId: MachineId,
  observedAt: string,
  skillName: string,
): SkillsShProvenanceObservation => ({
  type: "skills.sh-lock",
  machineId,
  observedAt,
  ...(lock.entry.updatedAt ? { sourceUpdatedAt: lock.entry.updatedAt } : {}),
  lockPath: lock.lockPath,
  lockVersion: lock.lockVersion,
  lockScope: lock.scope,
  lockContentHash: lock.lockContentHash,
  source: lock.entry.source,
  sourceType: lock.entry.sourceType,
  ...(lock.entry.sourceUrl ? { sourceUrl: lock.entry.sourceUrl } : {}),
  ...(lock.entry.sourceBaseUrl ? { sourceBaseUrl: lock.entry.sourceBaseUrl } : {}),
  ...(lock.entry.ref ? { ref: lock.entry.ref } : {}),
  skillName,
  ...(lock.entry.skillPath ? { skillPath: lock.entry.skillPath } : {}),
  ...(lock.entry.computedHash ? { computedHash: lock.entry.computedHash } : {}),
  ...(lock.entry.skillFolderHash ? { skillFolderHash: lock.entry.skillFolderHash } : {}),
  ...(lock.entry.wellKnownDigest ? { wellKnownDigest: lock.entry.wellKnownDigest } : {}),
  contentAgreement: lock.content,
  originalEntry: lock.entry.originalEntry,
});

/** Retain selected installed bytes from one freshly revalidated observation. */
export const applySetupObservedCollections = Effect.fn("Setup.applyObservedCollections")(function* (
  options: SetupObservedCollectionOptions,
  current: SetupResult,
  untrustedSelections: readonly unknown[],
) {
  const selections = yield* Schema.decodeUnknownEffect(Schema.Array(SetupKnownSourceSelection))(
    untrustedSelections,
  );
  const machineId = current.machineConfig.machineId;
  if (!machineId)
    return yield* new SetupObservedCollectionInvalid({
      name: "machine",
      reason: "machine-identity-missing",
    });
  const selected = new Set<string>();
  const groups = new Map<
    string,
    Array<
      Extract<
        (typeof current.onboarding.candidates)[number],
        { action: "import-observed-collection" }
      >
    >
  >();
  for (const selection of selections) {
    const key = `${selection.groupKey}\0${selection.name}\0${[...selection.paths].sort().join("\0")}`;
    if (selected.has(key))
      return yield* new SetupObservedCollectionInvalid({
        name: selection.name,
        reason: "duplicate-selection",
      });
    selected.add(key);
    const candidate = current.onboarding.candidates.find(
      (
        item,
      ): item is Extract<
        (typeof current.onboarding.candidates)[number],
        { action: "import-observed-collection" }
      > =>
        item.action === "import-observed-collection" &&
        item.groupKey === selection.groupKey &&
        item.name === selection.name &&
        samePaths(item.paths, selection.paths),
    );
    if (!candidate)
      return yield* new SetupObservedCollectionInvalid({
        name: selection.name,
        reason: "candidate-not-found",
      });
    groups.set(candidate.groupKey, [...(groups.get(candidate.groupKey) ?? []), candidate]);
  }

  const observedAt = new Date(
    yield* Effect.clockWith((clock) => clock.currentTimeMillis),
  ).toISOString();
  const retained = [];
  for (const [groupKey, candidates] of [...groups].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const first = candidates[0]!;
    const observedSkills = [];
    const provenance = [];
    const claimedMembers: Array<{ lock: SetupLockMatch; name: string }> = [];
    const fs = yield* FileSystem.FileSystem;
    for (const candidate of candidates) {
      const instances = current.instances.filter(
        (item) =>
          item.name === candidate.name &&
          candidate.paths.includes(item.path) &&
          item.locks.some((lock) => setupLockGroupKey(lock) === groupKey),
      );
      const matchingClaims = instances.flatMap((item) =>
        item.locks.filter((lock) => setupLockGroupKey(lock) === groupKey),
      );
      const claimVariants = new Set(
        matchingClaims.map((lock) =>
          [
            lock.entry.sourceType,
            lock.entry.source,
            lock.entry.sourceUrl ?? "",
            lock.entry.sourceBaseUrl ?? "",
            lock.entry.ref ?? "",
            lock.entry.skillPath ?? "",
          ].join("\0"),
        ),
      );
      if (claimVariants.size > 1)
        return yield* new SetupObservedCollectionInvalid({
          name: candidate.name,
          reason: "contested-observation",
        });
      const instance = [...instances].sort((left, right) => left.path.localeCompare(right.path))[0];
      const observedHash = instance?.contentIdentity.observedHash;
      const lock = instance?.locks.find((item) => setupLockGroupKey(item) === groupKey);
      if (!instance || !observedHash || !lock)
        return yield* new SetupObservedCollectionInvalid({
          name: candidate.name,
          reason: "observation-missing",
        });
      claimedMembers.push({ lock, name: candidate.name });
      observedSkills.push({
        name: candidate.name,
        sourcePath: instance.path,
        relativePath:
          lock.entry.sourceType === "well-known"
            ? candidate.name
            : retainedSkillPath(candidate.skillPath, candidate.name),
        observedHash,
      });
      for (const observation of instances.flatMap((item) =>
        item.locks.filter((candidateLock) => setupLockGroupKey(candidateLock) === groupKey),
      ))
        provenance.push(observationFor(observation, machineId, observedAt, candidate.name));
    }
    for (const lock of new Map(claimedMembers.map(({ lock }) => [lock.lockPath, lock])).values()) {
      const text = yield* fs
        .readFileString(lock.lockPath)
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
          ),
        );
      if (`sha256:${createHash("sha256").update(text).digest("hex")}` !== lock.lockContentHash)
        return yield* new SetupObservedCollectionInvalid({
          name: first.name,
          reason: "lock-changed",
        });
    }
    const resolution = resolveSkillsShSelectedSource(claimedMembers);
    if (resolution._tag !== "Resolved")
      return yield* new SetupObservedCollectionInvalid({
        name: first.name,
        reason: "source-unresolvable",
      });
    const source = resolution.source;
    retained.push(
      yield* Effect.scoped(
        retainObservedCollectionEffect({
          input: sourceLocator(source),
          source,
          retainedAt: observedAt,
          skills: observedSkills,
          observations: provenance,
        }),
      ),
    );
  }
  const persisted = yield* (yield* LibraryStore).inspect;
  if (!persisted.present)
    return yield* new SetupObservedCollectionInvalid({
      name: "Library",
      reason: "retention-missing",
    });
  for (const result of retained) {
    if (
      result.skills.length === 0 ||
      result.skills.some(
        (skill) =>
          !persisted.state.skills.some((candidate) => candidate.skill_id === skill.skill_id),
      )
    )
      return yield* new SetupObservedCollectionInvalid({
        name: result.collection?.collection_id ?? result.skills[0]?.skill_id ?? "Library",
        reason: "retention-missing",
      });
  }
  return { planId: current.onboarding.planId, retained };
});
