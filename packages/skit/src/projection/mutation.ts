import { copyLocalTreeEffect } from "../platform/copy-tree.js";
import { Data, Effect, FileSystem, Result, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { dirname, join, relative, resolve } from "node:path";
import {
  type OwnershipMarker,
  StoredOwnershipMarker,
  type ProjectionTarget,
  type Digest,
  type InvocationPolicy,
} from "../contracts.js";
import { LinkStat } from "../platform/link-stat.js";
import {
  applyInvocationPolicyEffect,
  declaredInvocationIntent,
  overrideInvocationIntent,
  type InvocationIntent,
} from "./policy.js";
import { deterministicTreeHashEffect } from "../artifact/skit.js";
import { TreeHasher } from "../artifact/tree-hasher.js";
import type { HarnessInvocationWriteFailure } from "../harnesses/projection.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
import type { TreeError } from "../shared/tree-error.js";
import {
  AdoptionContentMismatch,
  AdoptionTargetChanged,
  NoProjectionRoot,
  OwnershipMarkerDisagrees,
  ProjectionRetireConflict,
  UnsafeProjectionName,
} from "../failures.js";
import {
  type ProjectionId as ProjectionIdType,
  type SkillId as SkillIdType,
  type SkillVersionId as SkillVersionIdType,
} from "../library/entity-ids.js";
import type { ManagedProjection } from "../library/library-state.js";
import { libraryStateRevision, type LibraryState } from "../library/library-state.js";
import { projectionSourceEffect } from "../library/installation/projection-source.js";
import {
  backUpProjectionEffect,
  keepProjectionBackupEffect,
  losslessTreeEffect,
  pendingProjectionBackupsEffect,
  projectionWorkDirectoryEffect,
} from "./backups.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

const OwnershipMarkerDocument = Schema.fromJsonString(Schema.Unknown);

export type RetireProjectionResult =
  | { kind: "absent" }
  | { kind: "conflicted"; observed: Digest }
  | { kind: "retired"; observed: Digest };

export interface MaterializeProjectionRequest {
  /** Projection custody coordinate and retained root, without a publication contract. */
  installation: { readonly libraryPath: string };
  skill: {
    readonly skillId: SkillIdType;
    readonly skillVersionId: SkillVersionIdType;
    readonly name: string;
    readonly contentHash: Digest;
  };
  target: ProjectionTarget;
  /** An enclosing native batch can declare distinct roots on one target. */
  root?: string;
  sourcePath: string;
  shared?: Array<{ from: string; to: string }>;
  declaredInvocation?: InvocationPolicy;
  invocationIntent: InvocationIntent;
  previous?: ManagedProjection;
  /** Exact preview evidence authorizing Custody transfer of this unmanaged target. */
  adoption?: { path: string; observedHash: Digest };
  /** Exact preview evidence authorizing a changed managed Projection as the selected Version. */
  replacement?: {
    projectionId: ProjectionIdType;
    observedHash: Digest;
    marker: OwnershipMarker;
    /** Explicitly choosing the Library permits replacing the reviewed different bytes. */
    allowDifferent?: boolean;
  };
  state: ProjectionState;
  identity: {
    readonly projectionId: ProjectionIdType;
    readonly skillId: SkillIdType;
    readonly skillVersionId: SkillVersionIdType;
  };
  /** Explicit enable may recreate an absent Projection suppressed by native deletion. */
  restoreNativeDeletion?: boolean;
  projectedAt: string;
}

export interface ProjectionState extends LibraryState {}

/** A projection could not be materialized or verified. */
export class ProjectionFailure
  extends Data.TaggedError("ProjectionFailure")<{
    message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Run `skit doctor` to inspect the Projection, then retry.";
}

function exists(path: string): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(path);
  });
}

/** Shared owned copy policy, with Projection's existing unsupported-entry failure. */
const copyProjectionTree = Effect.fn("Projection.copyTree")((from: string, to: string) =>
  copyLocalTreeEffect(from, to, undefined, false).pipe(
    Effect.catchTag("TreeError", (error) =>
      Effect.fail(new ProjectionFailure({ message: error.message })),
    ),
  ),
);

const copySkill = Effect.fn("Projection.copySkill")(function* (
  request: Pick<
    MaterializeProjectionRequest,
    "sourcePath" | "shared" | "target" | "declaredInvocation" | "invocationIntent"
  > & { destination: string; libraryPath: string },
): Effect.fn.Return<
  void,
  ProjectionFailure | HarnessInvocationWriteFailure,
  FileSystem.FileSystem | LinkStat
> {
  const fs = yield* FileSystem.FileSystem;
  // overwrite stays false: copying onto an existing tree must fail, not merge.
  yield* copyProjectionTree(request.sourcePath, request.destination);
  for (const mapping of request.shared ?? []) {
    const target = resolve(request.destination, mapping.to);
    if (relative(request.destination, target).startsWith(".."))
      return yield* new ProjectionFailure({
        message: `Shared mapping target escaped child: ${mapping.to}`,
      });
    yield* fs.makeDirectory(dirname(target), { recursive: true }).pipe(Effect.uninterruptible);
    yield* copyProjectionTree(join(request.libraryPath, mapping.from), target);
  }
  yield* applyInvocationPolicyEffect(
    request.destination,
    request.target,
    request.declaredInvocation,
    request.invocationIntent,
  );
});

export function readOwnershipMarkerEffect(
  path: string,
): Effect.Effect<OwnershipMarker | null, PlatformError, FileSystem.FileSystem> {
  return inspectOwnershipMarkerEffect(path).pipe(
    Effect.map((inspected) => (inspected.kind === "valid" ? inspected.marker : null)),
  );
}

export type OwnershipMarkerInspection =
  | { kind: "absent" }
  | { kind: "invalid"; detail: string }
  | { kind: "valid"; marker: OwnershipMarker };

export function parseOwnershipMarker(value: unknown): OwnershipMarkerInspection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { kind: "invalid", detail: "Ownership marker must be a JSON object" };
  const decoded = Schema.decodeUnknownOption(StoredOwnershipMarker)(value);
  if (decoded._tag === "Some") return { kind: "valid", marker: decoded.value };
  return { kind: "invalid", detail: "Ownership marker has invalid typed fields" };
}

const markerExpectedHash = (marker: OwnershipMarker): Digest => marker.expected_digest;

// Custody is the Projection and Skill; a new selected Version is an ordinary rewrite, and the
// expected-digest check below is what detects local edits.
const markerMatches = (
  marker: OwnershipMarker,
  request: Pick<MaterializeProjectionRequest, "identity">,
) =>
  marker.projection_id === request.identity.projectionId &&
  marker.skill_id === request.identity.skillId;

const sameMarker = (left: OwnershipMarker, right: OwnershipMarker) =>
  left.projection_id === right.projection_id &&
  left.skill_id === right.skill_id &&
  left.skill_version_id === right.skill_version_id &&
  left.expected_digest === right.expected_digest;

const ownershipMarker = (
  request: MaterializeProjectionRequest,
  projectionId: ProjectionIdType,
  expectedHash: Digest,
): OwnershipMarker => ({
  schemaVersion: 4,
  projectionPolicyVersion: 1,
  projection_id: request.identity.projectionId,
  skill_id: request.identity.skillId,
  skill_version_id: request.identity.skillVersionId,
  expected_digest: expectedHash,
});

export function inspectOwnershipMarkerEffect(
  path: string,
): Effect.Effect<OwnershipMarkerInspection, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // A missing marker is absent; unreadable is a real failure; unparseable is invalid.
    const text = yield* fs
      .readFileString(join(path, ".skit-ownership.json"))
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
    if (text === undefined) return { kind: "absent" as const };
    const parsed = Schema.decodeUnknownOption(OwnershipMarkerDocument)(text);
    return parsed._tag === "Some"
      ? parseOwnershipMarker(parsed.value)
      : ({ kind: "invalid", detail: "Ownership marker is invalid JSON" } as const);
  });
}

/** Pure hash policy: disagreement is data, not a thrown domain exception. */
export function expectedProjectionHashResult(
  projection: ManagedProjection,
  marker: OwnershipMarker | null,
): Result.Result<Digest, OwnershipMarkerDisagrees> {
  if (marker && projection.expected_digest !== markerExpectedHash(marker))
    return Result.fail(
      new OwnershipMarkerDisagrees({
        skillId: projection.skill_id,
        target: projection.target,
      }),
    );
  return Result.succeed(projection.expected_digest);
}

/** Moves an owned copy into a pending backup for the mutation that will settle it. */
type BackUp = (
  projection: ManagedProjection,
  action: "replace" | "retire",
) => Effect.Effect<void, PlatformError, FileSystem.FileSystem>;

const materializeProjectionEffect = Effect.fn("Projection.materialize")(function* (
  request: MaterializeProjectionRequest,
  context: NativeProjectionContext & { readonly backUp: BackUp },
): Effect.fn.Return<
  { projection: ManagedProjection; changed: boolean },
  ProjectionMutationError,
  TreeRequirements | TreeHasher
> {
  let changed = false;
  const fs = yield* FileSystem.FileSystem;
  const hasher = yield* TreeHasher;
  const { installation, skill, target, previous } = request;
  const root = request.root ?? context.rootFor(target);
  if (!root) return yield* Effect.fail(new NoProjectionRoot({ target }));
  yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
  const destination = join(root, yield* projectionNameEffect(skill.name));
  const projectionId = request.identity.projectionId;
  const prior = previous?.projection_id === projectionId ? previous : undefined;
  const workDirectory = yield* projectionWorkDirectoryEffect(root);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      // Staged on the root's own device, so installing it is a rename even through a symlink.
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: workDirectory,
        prefix: ".skit-stage-",
      });
      const temporary = join(staging, "projection");
      yield* copySkill({
        ...request,
        destination: temporary,
        libraryPath: installation.libraryPath,
      });
      const desiredHash = yield* deterministicTreeHashEffect(temporary);
      const projection: ManagedProjection = {
        projection_id: projectionId,
        skill_id: request.identity.skillId,
        skill_version_id: request.identity.skillVersionId,
        target,
        root,
        path: destination,
        expected_digest: desiredHash,
        status: "pending",
        projected_at: request.projectedAt,
      };
      const settled = () => projection;
      /**
       * Commit custody of the selected Version and verify it. `marker` stamps equal bytes in place,
       * keeping whatever the hash leaves out; `replace` first moves the owned original into a
       * pending backup; `install` refuses a destination that appeared since it was observed.
       */
      const commit = Effect.fn("Projection.commit")(function* (
        mode: "marker" | "replace" | "install",
        verification: string,
      ) {
        const marker = `${JSON.stringify(ownershipMarker(request, projectionId, desiredHash), null, 2)}\n`;
        // Stamping through a link would claim a directory outside the root, so a linked
        // destination is replaced instead, and the link itself kept in a backup.
        const inPlace =
          mode === "marker" &&
          (yield* (yield* LinkStat).lstat(destination)).type !== "SymbolicLink";
        if (inPlace) {
          // Stage outside the projected tree so an interrupted write cannot leave hash drift.
          const markerTemporary = join(staging, "ownership.json");
          yield* fs.writeFileString(markerTemporary, marker, { mode: 0o600, flag: "wx" });
          yield* fs
            .rename(markerTemporary, join(destination, ".skit-ownership.json"))
            .pipe(Effect.uninterruptible);
        } else {
          yield* fs.writeFileString(join(temporary, ".skit-ownership.json"), marker, {
            mode: 0o600,
          });
          if (mode !== "install") yield* context.backUp(projection, "replace");
          else if (yield* fs.exists(destination))
            return yield* new ProjectionFailure({
              message: `Projection appeared before materialization: ${destination}`,
            });
          yield* fs.rename(temporary, destination).pipe(Effect.uninterruptible);
        }
        const observed = yield* hasher.hash(destination);
        if (observed !== desiredHash)
          return yield* new ProjectionFailure({
            message: `Post-${verification} hash verification failed for ${skill.skillId} at ${target}`,
          });
        changed = true;
        return { ...projection, status: "installed" as const, observed_digest: observed };
      });
      const nativeDeletion =
        !request.restoreNativeDeletion &&
        prior?.status === "suppressed" &&
        prior.suppression_reason === "native_delete" &&
        !(yield* exists(destination)) &&
        !(yield* projectionDisplacedEffect(prior));
      if (nativeDeletion) {
        projection.status = "suppressed";
        projection.suppression_reason = "native_delete";
        projection.suppressed_at = prior.suppressed_at;
        projection.observed_digest = prior.observed_digest;
        return settled();
      }
      if (yield* exists(destination)) {
        const markerInspection = yield* inspectOwnershipMarkerEffect(destination);
        const marker = markerInspection.kind === "valid" ? markerInspection.marker : null;
        const observed = yield* hasher.hash(destination);
        const adoptionPath = request.adoption?.path;
        const adoptionMatchesDestination = adoptionPath
          ? (yield* fs
              .realPath(adoptionPath)
              .pipe(Effect.orElseSucceed(() => resolve(adoptionPath)))) ===
            (yield* fs.realPath(destination).pipe(Effect.orElseSucceed(() => resolve(destination))))
          : false;
        const replacementMatches =
          request.replacement !== undefined &&
          request.replacement.projectionId === projectionId &&
          request.replacement.observedHash === observed &&
          marker !== null &&
          sameMarker(marker, request.replacement.marker);
        if (replacementMatches && observed === desiredHash)
          return yield* commit("marker", "replacement");
        if (replacementMatches && request.replacement?.allowDifferent)
          return yield* commit("replace", "reviewed replacement");
        if (!marker || !markerMatches(marker, request)) {
          if (
            markerInspection.kind === "absent" &&
            request.adoption &&
            adoptionMatchesDestination
          ) {
            if (observed !== request.adoption.observedHash)
              return yield* new AdoptionTargetChanged({ path: destination });
            if (observed !== desiredHash)
              return yield* new AdoptionContentMismatch({ path: destination });
            // Equal content is adopted in place, keeping every entry the hash leaves out.
            return yield* commit("marker", "adoption");
          }
          projection.status = "conflicted";
          projection.observed_digest = observed;
          return settled();
        }
        if (observed !== markerExpectedHash(marker)) {
          const variant = join(
            context.variantsPath,
            target,
            yield* projectionNameEffect(skill.name),
            observed.slice(7),
          );
          if (!(yield* exists(variant))) {
            yield* fs.makeDirectory(dirname(variant), { recursive: true });
            const variantStaging = yield* fs.makeTempDirectoryScoped({
              directory: dirname(variant),
              prefix: ".skit-stage-",
            });
            const temporaryVariant = join(variantStaging, "variant");
            yield* copyProjectionTree(destination, temporaryVariant);
            yield* fs.rename(temporaryVariant, variant).pipe(Effect.uninterruptible);
          }
          return {
            ...projection,
            expected_digest: prior?.expected_digest ?? markerExpectedHash(marker),
            status: "conflicted" as const,
            observed_digest: observed,
          };
        }
        if (observed === desiredHash) {
          if (marker.skill_version_id !== request.identity.skillVersionId)
            return yield* commit("marker", "marker");
          projection.status = "installed";
          projection.observed_digest = observed;
          return settled();
        }
        return yield* commit("replace", "write");
      }
      return yield* commit("install", "write");
    }),
  ).pipe(Effect.map((projection) => ({ projection, changed })));
});

/**
 * Whether a recorded Projection is still the one SKIT wrote.
 *
 * This is the custody question `retire` asks immediately before displacing anything, separated so
 * a caller can also ask it *first*. A batch may use that to refuse before changing any derived
 * directory.
 */
export const projectionCustodyEffect = Effect.fn("Projection.custody")(function* (
  projection: ManagedProjection,
): Effect.fn.Return<
  | { kind: "absent" }
  | { kind: "intact"; observed: Digest; marker: OwnershipMarker }
  | { kind: "conflicted"; observed: Digest },
  OwnershipMarkerDisagrees | TreeError | PlatformError,
  TreeRequirements | TreeHasher
> {
  const destination = projection.path;
  if (!(yield* exists(destination))) return { kind: "absent" as const };
  const marker = yield* readOwnershipMarkerEffect(destination);
  const observed = yield* (yield* TreeHasher).hash(destination);
  if (
    !marker ||
    marker.skill_id !== projection.skill_id ||
    marker.projection_id !== projection.projection_id ||
    observed !== markerExpectedHash(marker)
  )
    return { kind: "conflicted" as const, observed };
  return { kind: "intact" as const, observed, marker };
});

const retireProjectionEffect = Effect.fn("Projection.retire")(function* (
  projection: ManagedProjection,
  onConflict: "throw" | "report",
  conflictMessage: string,
  backUp: BackUp,
): Effect.fn.Return<
  RetireProjectionResult,
  ProjectionRetireConflict | OwnershipMarkerDisagrees | TreeError | PlatformError,
  TreeRequirements | TreeHasher
> {
  const custody = yield* projectionCustodyEffect(projection);
  if (custody.kind === "absent") return { kind: "absent" as const };
  if (custody.kind === "conflicted") {
    if (onConflict === "report") return { kind: "conflicted" as const, observed: custody.observed };
    return yield* new ProjectionRetireConflict({ detail: conflictMessage });
  }
  const { observed } = custody;
  yield* backUp(projection, "retire");
  return {
    kind: "retired" as const,
    observed,
  };
});

/**
 * Whether a pending backup holds the very copy a recorded Projection describes, so it still
 * explains that Projection's absence. A backup of an earlier copy explains nothing about a later one.
 */
export const projectionDisplacedEffect = Effect.fn("Projection.displaced")(function* (
  projection: ManagedProjection,
) {
  for (const backup of yield* pendingProjectionBackupsEffect(projection)) {
    const marker = yield* readOwnershipMarkerEffect(backup);
    if (
      marker?.projection_id === projection.projection_id &&
      marker.expected_digest === projection.expected_digest
    )
      return true;
  }
  return false;
});

/**
 * Whether a backup is exactly what SKIT would write again, proven only from `prior`, the Library
 * state the mutation loaded: the backup's marker must name the recorded Projection and Version, that
 * Version's retained original must be intact, and restaging it under a recorded invocation policy
 * must reproduce every name, type, mode and byte. Anything short of that proof keeps the backup.
 */
const reproducibleEffect = Effect.fn("Projection.reproducible")(function* (
  backup: string,
  prior: LibraryState,
  originalsPath: string,
  projectionId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const recorded = prior.projections.find((item) => item.projection_id === projectionId);
  const marker = yield* readOwnershipMarkerEffect(backup);
  if (
    recorded === undefined ||
    marker?.projection_id !== recorded.projection_id ||
    marker.skill_id !== recorded.skill_id ||
    marker.skill_version_id !== recorded.skill_version_id
  )
    return false;
  const skill = prior.skills.find((item) => item.skill_id === recorded.skill_id);
  const version = skill?.versions.find(
    (item) => item.skill_version_id === recorded.skill_version_id,
  );
  const target = recorded.target;
  // A former per-Harness root's transforms are no longer known, so its copy cannot be restaged.
  if (skill === undefined || version === undefined || target === "legacy") return false;
  const source = yield* projectionSourceEffect(prior, originalsPath, skill, version);
  const expected = yield* losslessTreeEffect(backup);
  if (source.kind === "invalid" || expected === undefined) return false;
  const policies = new Set(
    [...prior.global_bindings, ...prior.local_bindings].flatMap((binding) => {
      const policy = binding.invocation_policies?.[skill.skill_id];
      return policy === undefined ? [] : [policy];
    }),
  );
  for (const invocationIntent of [
    declaredInvocationIntent,
    ...[...policies].map(overrideInvocationIntent),
  ]) {
    const restaged = yield* Effect.scoped(
      Effect.gen(function* () {
        const destination = join(
          yield* fs.makeTempDirectoryScoped({ prefix: "skit-reproduce-" }),
          "projection",
        );
        yield* copySkill({ ...source, target, invocationIntent, destination });
        return yield* losslessTreeEffect(destination);
      }),
    );
    if (restaged === expected) return true;
  }
  return false;
});
export type ProjectionMutationError =
  | AdoptionContentMismatch
  | AdoptionTargetChanged
  | ProjectionFailure
  | NoProjectionRoot
  | UnsafeProjectionName
  | OwnershipMarkerDisagrees
  | ProjectionRetireConflict
  | HarnessInvocationWriteFailure
  | TreeError
  | PlatformError;

export interface NativeProjectionContext {
  readonly rootFor: (target: ProjectionTarget) => string | undefined;
  readonly variantsPath: string;
}

export const projectionNameEffect = Effect.fn("Projection.name")(function* (name: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return yield* new UnsafeProjectionName({ name });
  return name;
});
export interface ProjectionMutation<S extends ProjectionState = ProjectionState> {
  readonly state: S;
  readonly project: (
    request: Omit<MaterializeProjectionRequest, "state">,
  ) => Effect.Effect<ManagedProjection, ProjectionMutationError, TreeRequirements | TreeHasher>;
  readonly retire: (
    projection: ManagedProjection,
    onConflict: "throw" | "report",
    conflictMessage: string,
  ) => Effect.Effect<
    Exclude<RetireProjectionResult, { kind: "retired" }> | { kind: "retired"; observed: Digest },
    ProjectionMutationError,
    TreeRequirements | TreeHasher
  >;
}

/**
 * Owns one private candidate and publishes it once after all derived filesystem work succeeds.
 *
 * Nothing is rolled back. A failed batch instead publishes what its verified filesystem work left
 * behind: each copy it wrote and verified as installed, and each it moved aside, leaving nothing in
 * its place, as `pending`, so an absence SKIT caused is never read as a native deletion. A write
 * that fails verification publishes nothing for its Projection. After a publish, pending backups of
 * every Projection the batch touched are settled: discarded only when the loaded state proves the
 * retained original reproduces them, otherwise kept. A batch that leaves the state as loaded, wrote
 * nothing and has no backup to settle publishes nothing.
 */
export const withProjectionMutationEffect = Effect.fn("Projection.mutate")(function* <
  S extends ProjectionState,
  T,
  PE,
  PR,
  SE,
  SR,
>(
  loaded: S,
  context: NativeProjectionContext & {
    /** Where retained originals live, to prove a backup reproducible before discarding it. */
    readonly originalsPath: string;
    /** Publish `next` only if the Library is still `base`, the state this mutation loaded. */
    readonly publish: (next: S, base: S) => Effect.Effect<void, PE, PR>;
  },
  stage: (mutation: ProjectionMutation<S>) => Effect.Effect<T, SE, SR>,
) {
  const fs = yield* FileSystem.FileSystem;
  const candidate = structuredClone(loaded);
  const changedProjections = new Set<string>();
  const touched = new Map<string, ManagedProjection>();
  const onDisk = new Map<string, ManagedProjection>();
  const backUp: BackUp = (projection, action) =>
    backUpProjectionEffect(projection, action).pipe(
      Effect.map(() => {
        onDisk.set(projection.projection_id, { ...projection, status: "pending" });
      }),
    );
  const mutation: ProjectionMutation<S> = {
    state: candidate,
    project: Effect.fn("Projection.project")(function* (request) {
      const root = request.root ?? context.rootFor(request.target);
      if (!root) return yield* new NoProjectionRoot({ target: request.target });
      yield* projectionNameEffect(request.skill.name);
      const projectionId = request.identity.projectionId;
      const result = yield* materializeProjectionEffect(
        { ...request, state: candidate },
        { ...context, backUp },
      ).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            const displaced = onDisk.get(projectionId);
            // An unverified successor now stands where the original was: never call it pending.
            if (displaced !== undefined && (yield* fs.exists(displaced.path)))
              onDisk.delete(projectionId);
          }).pipe(Effect.orElseSucceed(() => onDisk.delete(projectionId))),
        ),
      );
      touched.set(projectionId, result.projection);
      if (result.changed) {
        changedProjections.add(projectionId);
        onDisk.set(projectionId, result.projection);
      }
      return result.projection;
    }),
    retire: Effect.fn("Projection.retire")(function* (projection, onConflict, message) {
      touched.set(projection.projection_id, projection);
      const result = yield* retireProjectionEffect(projection, onConflict, message, backUp);
      return result.kind === "retired"
        ? { kind: "retired" as const, observed: result.observed }
        : result;
    }),
  };
  const publishOnDisk = Effect.suspend(() => {
    if (onDisk.size === 0) return Effect.void;
    const next = structuredClone(loaded);
    for (const projection of onDisk.values()) {
      const index = next.projections.findIndex(
        (item) => item.projection_id === projection.projection_id,
      );
      if (index >= 0) next.projections[index] = projection;
      else next.projections.push(projection);
    }
    return context.publish(next, loaded);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Projections changed, but the Library could not record them", cause),
    ),
  );
  const value = yield* stage(mutation).pipe(Effect.onError(() => publishOnDisk));
  const pending = yield* Effect.forEach([...touched.values()], (projection) =>
    Effect.map(pendingProjectionBackupsEffect(projection), (backups) =>
      backups.map((backup) => ({ backup, projectionId: projection.projection_id })),
    ),
  ).pipe(
    Effect.map((backups) => backups.flat()),
    Effect.catchCause((cause) =>
      Effect.as(Effect.logWarning("Projection backups stayed pending", cause), []),
    ),
  );
  // The publish also proves `loaded` is still the Library's, which settling a backup relies on.
  if (
    onDisk.size > 0 ||
    pending.length > 0 ||
    libraryStateRevision(candidate) !== libraryStateRevision(loaded)
  )
    yield* context.publish(candidate, loaded);
  yield* Effect.gen(function* () {
    for (const { backup, projectionId } of pending)
      if (
        yield* reproducibleEffect(backup, loaded, context.originalsPath, projectionId).pipe(
          Effect.orElseSucceed(() => false),
        )
      )
        yield* fs.remove(backup, { recursive: true });
      else yield* keepProjectionBackupEffect(backup);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Library changed, but projection backups stayed pending", cause),
    ),
  );
  return { state: candidate, value, projected: changedProjections.size };
});
