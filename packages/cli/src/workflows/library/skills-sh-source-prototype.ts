import { Context, Effect, Result, Schema } from "effect";
import type { Digest } from "@smolai/skit-core";

/** A coordinate that can be fetched. It says nothing about which Skills are installed. */
export const SkillSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("github"), owner: Schema.String, repo: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("endpoint"), url: Schema.String }),
]);
export type SkillSource = typeof SkillSource.Type;

const sourceKey = (source: SkillSource): string =>
  source.kind === "github" ? `github:${source.owner}/${source.repo}` : `endpoint:${source.url}`;

/** The lock's selected members and skills.sh hashes are claims, not observations. */
export const SkillsShLockCollectionClaim = Schema.Struct({
  lockPath: Schema.String,
  scopeRoot: Schema.String,
  source: SkillSource,
  members: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      claimedPath: Schema.optionalKey(Schema.String),
      claimedSkillsShHash: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type SkillsShLockCollectionClaim = typeof SkillsShLockCollectionClaim.Type;

/** Disk and fetched upstream are separate observations, even when their bytes agree. */
export interface AgentSkillInstance {
  readonly name: string;
  readonly localPath: string;
  readonly scopeRoot: string;
  readonly contentDigest: Digest;
  readonly skillsShHash: string;
}
export type PairedLockMember =
  | {
      readonly kind: "paired";
      readonly claim: SkillsShLockCollectionClaim["members"][number];
      readonly instance: AgentSkillInstance;
    }
  | {
      readonly kind: "missing-local";
      readonly claim: SkillsShLockCollectionClaim["members"][number];
    }
  | { readonly kind: "contested"; readonly claim: SkillsShLockCollectionClaim["members"][number] };
/** A calculated relationship; it has no separate identity or persistence contract. */
export interface LockClaimPairing {
  readonly lock: SkillsShLockCollectionClaim;
  readonly members: readonly PairedLockMember[];
}
export interface PairingResult {
  readonly paired: readonly LockClaimPairing[];
  readonly unclaimed: readonly AgentSkillInstance[];
  readonly contested: readonly { instance: AgentSkillInstance; lockPaths: readonly string[] }[];
}

const lockKey = (lock: SkillsShLockCollectionClaim): string =>
  `${lock.lockPath}\0${sourceKey(lock.source)}`;

/** Pair only within an observed scope; duplicate or competing claims remain contested. */
export const pairLockClaims = (
  locks: readonly SkillsShLockCollectionClaim[],
  instances: readonly AgentSkillInstance[],
): PairingResult => {
  const duplicateLocks = new Set<string>();
  const lockCounts = new Map<string, number>();
  for (const lock of locks) {
    const key = lockKey(lock);
    const count = (lockCounts.get(key) ?? 0) + 1;
    lockCounts.set(key, count);
    if (count > 1) duplicateLocks.add(key);
  }
  const claimsFor = (instance: AgentSkillInstance) =>
    locks.filter(
      (lock) =>
        lock.scopeRoot === instance.scopeRoot &&
        lock.members.some((member) => member.name === instance.name),
    );
  const unclaimed = instances.filter((instance) => claimsFor(instance).length === 0);
  const contested = instances.flatMap((instance) => {
    const candidates = claimsFor(instance);
    const sameNameInstances = instances.filter(
      (other) => other.scopeRoot === instance.scopeRoot && other.name === instance.name,
    );
    const duplicateMember = candidates.some(
      (lock) => lock.members.filter((member) => member.name === instance.name).length > 1,
    );
    return candidates.length > 1 ||
      sameNameInstances.length > 1 ||
      duplicateMember ||
      candidates.some((lock) => duplicateLocks.has(lockKey(lock)))
      ? [{ instance, lockPaths: candidates.map((lock) => lock.lockPath) }]
      : [];
  });
  const paired = locks.map((lock): LockClaimPairing => ({
    lock,
    members: lock.members.map((claim): PairedLockMember => {
      const matches = instances.filter(
        (instance) => instance.scopeRoot === lock.scopeRoot && instance.name === claim.name,
      );
      const competingLocks = locks.filter(
        (candidate) =>
          candidate.scopeRoot === lock.scopeRoot &&
          candidate.members.some((member) => member.name === claim.name),
      );
      if (
        duplicateLocks.has(lockKey(lock)) ||
        lock.members.filter((member) => member.name === claim.name).length > 1 ||
        competingLocks.length > 1 ||
        matches.length > 1
      )
        return { kind: "contested", claim };
      if (matches.length === 0) return { kind: "missing-local", claim };
      return { kind: "paired", claim, instance: matches[0]! };
    }),
  }));
  return { paired, unclaimed, contested };
};
export interface UpstreamMember {
  readonly name: string;
  readonly path: string;
  readonly contentDigest: Digest;
  readonly skillsShHash: string;
}
export interface SourceSnapshot {
  readonly source: SkillSource;
  readonly observedAt: string;
  readonly revision?: string;
  readonly members: readonly UpstreamMember[];
}

export class SourceUnavailable extends Schema.TaggedError<SourceUnavailable>()(
  "SourceUnavailable",
  { source: Schema.String },
) {}

export class SourceSnapshotReader extends Context.Service<
  SourceSnapshotReader,
  {
    readonly fetch: (source: SkillSource) => Effect.Effect<SourceSnapshot, SourceUnavailable>;
  }
>()("skit/prototype/SourceSnapshotReader") {}

export type MemberResolution =
  | { readonly kind: "exact" | "resolved-by-name"; readonly member: UpstreamMember }
  | { readonly kind: "ambiguous"; readonly paths: readonly string[] }
  | { readonly kind: "orphaned" };

export type AssessmentStatus =
  | "in-sync"
  | "upstream-ahead"
  | "locally-modified"
  | "diverged"
  | "lock-stale"
  | "evidence-conflict"
  | "unverifiable"
  | "orphaned"
  | "ambiguous"
  | "contested"
  | "missing-local";
export interface MemberAssessment {
  readonly name: string;
  readonly status: AssessmentStatus;
  readonly resolution?: MemberResolution;
  readonly localContentDigest?: Digest;
  readonly localSkillsShHash?: string;
  readonly claimedSkillsShHash?: string;
  readonly upstreamContentDigest?: Digest;
  readonly upstreamSkillsShHash?: string;
}

export const resolveLockedMember = (
  claim: SkillsShLockCollectionClaim["members"][number],
  snapshot: SourceSnapshot,
): MemberResolution => {
  if (claim.claimedPath) {
    const member = snapshot.members.find(
      (candidate) => candidate.path === claim.claimedPath && candidate.name === claim.name,
    );
    return member ? { kind: "exact", member } : { kind: "orphaned" };
  }
  const names = snapshot.members.filter((candidate) => candidate.name === claim.name);
  if (names.length === 1) return { kind: "resolved-by-name", member: names[0]! };
  if (names.length > 1) return { kind: "ambiguous", paths: names.map((item) => item.path) };
  return { kind: "orphaned" };
};

export const assessLockClaimPairing = (
  pairing: LockClaimPairing,
  snapshot: SourceSnapshot | undefined,
): readonly MemberAssessment[] =>
  pairing.members.map((member) => {
    const claim = member.claim;
    if (member.kind === "contested") return { name: claim.name, status: "contested" };
    if (member.kind === "missing-local") return { name: claim.name, status: "missing-local" };
    const local = member.instance;
    if (!snapshot)
      return { name: claim.name, status: "unverifiable", localContentDigest: local.contentDigest };
    const resolution = resolveLockedMember(claim, snapshot);
    if (resolution.kind === "ambiguous")
      return {
        name: claim.name,
        status: "ambiguous",
        resolution,
        localContentDigest: local.contentDigest,
      };
    if (resolution.kind === "orphaned")
      return {
        name: claim.name,
        status: "orphaned",
        resolution,
        localContentDigest: local.contentDigest,
      };
    const upstream = resolution.member;
    const claimed = claim.claimedSkillsShHash;
    if (!claimed)
      return {
        name: claim.name,
        status: "unverifiable",
        resolution,
        localContentDigest: local.contentDigest,
        upstreamContentDigest: upstream.contentDigest,
      };
    const evidenceConflict =
      (local.skillsShHash === upstream.skillsShHash) !==
      (local.contentDigest === upstream.contentDigest);
    const status: AssessmentStatus = evidenceConflict
      ? "evidence-conflict"
      : local.skillsShHash === claimed && upstream.skillsShHash === claimed
        ? "in-sync"
        : local.skillsShHash === claimed
          ? "upstream-ahead"
          : upstream.skillsShHash === claimed
            ? "locally-modified"
            : local.contentDigest === upstream.contentDigest
              ? "lock-stale"
              : "diverged";
    return {
      name: claim.name,
      status,
      resolution,
      localContentDigest: local.contentDigest,
      localSkillsShHash: local.skillsShHash,
      claimedSkillsShHash: claimed,
      upstreamContentDigest: upstream.contentDigest,
      upstreamSkillsShHash: upstream.skillsShHash,
    };
  });

/** Fetch once per coordinate, then assess each lock claim against its derived pairing. */
export const checkLockClaims = Effect.fn("Prototype.checkLockClaims")(function* (
  locks: readonly SkillsShLockCollectionClaim[],
  instances: readonly AgentSkillInstance[],
) {
  const reader = yield* SourceSnapshotReader;
  const pairing = pairLockClaims(locks, instances);
  const snapshots = new Map<string, SourceSnapshot | undefined>();
  const results = [];
  for (const view of pairing.paired) {
    const key = sourceKey(view.lock.source);
    if (!snapshots.has(key)) {
      const fetched = yield* reader.fetch(view.lock.source).pipe(Effect.result);
      snapshots.set(
        key,
        Result.isSuccess(fetched) && sourceKey(fetched.success.source) === key
          ? fetched.success
          : undefined,
      );
    }
    results.push({
      lockPath: view.lock.lockPath,
      source: view.lock.source,
      snapshot: snapshots.get(key),
      assessments: assessLockClaimPairing(view, snapshots.get(key)),
    });
  }
  return { ...pairing, checks: results };
});
