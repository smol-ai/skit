import { copyLocalTreeEffect } from "../platform/copy-tree.js";
import { Data, Effect, FileSystem, Result, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { dirname, join, relative, resolve } from "node:path";
import { HarnessName, OwnershipMarker, type Digest, type InvocationPolicy } from "../contracts.js";
import { LinkStat } from "../platform/link-stat.js";
import { applyInvocationPolicyEffect, type InvocationIntent } from "./policy.js";
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
  type CollectionId as CollectionIdType,
  type ProjectionId as ProjectionIdType,
  type SkillId as SkillIdType,
  type SkillVersionId as SkillVersionIdType,
} from "../library/entity-ids.js";
import type { ManagedProjection } from "../library/portable-local-state.js";

const OwnershipMarkerDocument = Schema.fromJsonString(Schema.Unknown);
const ADOPTION_RECOVERY_FILE = ".skit-adoption-recovery.json";
const AdoptionRecoveryMarker = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operation: Schema.Literal("adoption-swap"),
  destination: Schema.String,
  displaced: Schema.String,
});

export type RetireProjectionResult =
  | { kind: "absent" }
  | { kind: "conflicted"; observed: Digest }
  | { kind: "retired"; observed: Digest };

export interface MaterializeProjectionRequest {
  /** Projection custody coordinate and retained root, without a publication contract. */
  installation: { readonly collectionId: CollectionIdType; readonly libraryPath: string };
  skill: {
    readonly skillId: SkillIdType;
    readonly skillVersionId: SkillVersionIdType;
    readonly name: string;
    readonly contentHash: Digest;
  };
  harness: HarnessName;
  /** An enclosing native batch can declare distinct roots on one Harness. */
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
  };
  state: ProjectionState;
  identity: {
    readonly projectionId: ProjectionIdType;
    readonly collectionId: CollectionIdType;
    readonly skillId: SkillIdType;
    readonly skillVersionId: SkillVersionIdType;
  };
  projectedAt: string;
}

export interface ProjectionState {}

/** A projection could not be materialized or verified. */
export class ProjectionFailure extends Data.TaggedError("ProjectionFailure")<{
  message: string;
}> {}

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
    "sourcePath" | "shared" | "harness" | "declaredInvocation" | "invocationIntent"
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
    request.harness,
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
  const decoded = Schema.decodeUnknownOption(OwnershipMarker)(value);
  return decoded._tag === "Some"
    ? { kind: "valid", marker: decoded.value }
    : { kind: "invalid", detail: "Ownership marker has invalid typed fields" };
}

const markerExpectedHash = (marker: OwnershipMarker): Digest => marker.expected_digest;

const markerMatches = (
  marker: OwnershipMarker,
  request: Pick<MaterializeProjectionRequest, "identity">,
) =>
  marker.projection_id === request.identity.projectionId &&
  marker.collection_id === request.identity.collectionId &&
  marker.skill_id === request.identity.skillId &&
  marker.skill_version_id === request.identity.skillVersionId;

const sameMarker = (left: OwnershipMarker, right: OwnershipMarker) =>
  left.projection_id === right.projection_id &&
  left.collection_id === right.collection_id &&
  left.skill_id === right.skill_id &&
  left.skill_version_id === right.skill_version_id &&
  left.expected_digest === right.expected_digest &&
  left.harness === right.harness;

const ownershipMarker = (
  request: MaterializeProjectionRequest,
  projectionId: ProjectionIdType,
  expectedHash: Digest,
): OwnershipMarker => ({
  schemaVersion: 2,
  projectionPolicyVersion: 1,
  projection_id: request.identity.projectionId,
  collection_id: request.identity.collectionId,
  skill_id: request.identity.skillId,
  skill_version_id: request.identity.skillVersionId,
  expected_digest: expectedHash,
  harness: request.harness,
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
        skillRef: projection.skill_id,
        harness: projection.harness,
      }),
    );
  return Result.succeed(projection.expected_digest);
}

const materializeProjectionEffect = Effect.fn("Projection.materialize")(function* (
  request: MaterializeProjectionRequest,
  context: NativeProjectionContext,
): Effect.fn.Return<ManagedProjection, ProjectionMutationError, TreeRequirements | TreeHasher> {
  const fs = yield* FileSystem.FileSystem;
  const hasher = yield* TreeHasher;
  const { installation, skill, harness, previous } = request;
  const root = request.root ?? context.rootFor(harness);
  if (!root) return yield* Effect.fail(new NoProjectionRoot({ harness }));
  yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
  const destination = join(root, yield* projectionName(skill.name));
  const projectionId = request.identity.projectionId;
  const prior = previous?.projection_id === projectionId ? previous : undefined;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: dirname(root),
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
        collection_id: request.identity.collectionId,
        skill_id: request.identity.skillId,
        skill_version_id: request.identity.skillVersionId,
        harness,
        root,
        path: destination,
        expected_digest: desiredHash,
        status: "pending",
        projected_at: request.projectedAt,
      };
      const settled = () => projection;
      const nativeDeletion =
        prior?.status === "suppressed" &&
        prior.suppression_reason === "native_delete" &&
        !(yield* exists(destination));
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
          observed === desiredHash &&
          marker !== null &&
          sameMarker(marker, request.replacement.marker);
        if (replacementMatches) {
          yield* fs.writeFileString(
            join(destination, ".skit-ownership.json"),
            `${JSON.stringify(ownershipMarker(request, projectionId, desiredHash), null, 2)}\n`,
            { mode: 0o600 },
          );
          const acceptedHash = yield* hasher.hash(destination);
          if (acceptedHash !== desiredHash)
            return yield* new ProjectionFailure({
              message: `Post-replacement hash verification failed for ${skill.skillId} on ${harness}`,
            });
          projection.status = "installed";
          projection.observed_digest = acceptedHash;
          return projection;
        }
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
            const adoptedMarker = ownershipMarker(request, projectionId, desiredHash);
            yield* fs.writeFileString(
              join(temporary, ".skit-ownership.json"),
              `${JSON.stringify(adoptedMarker, null, 2)}\n`,
              { mode: 0o600 },
            );
            const displaced = join(staging, "unmanaged-original");
            const recovery = AdoptionRecoveryMarker.make({
              schemaVersion: 1,
              operation: "adoption-swap",
              destination,
              displaced,
            });
            // This marker is durable before Custody moves. A killed process therefore leaves the
            // original in a named location with its intended destination instead of anonymous
            // temporary residue. Graceful failure still rolls back and scoped cleanup removes it.
            yield* fs
              .writeFileString(
                join(staging, ADOPTION_RECOVERY_FILE),
                `${JSON.stringify(recovery, null, 2)}\n`,
                { mode: 0o600 },
              )
              .pipe(Effect.uninterruptible);
            yield* fs.rename(destination, displaced).pipe(Effect.uninterruptible);
            yield* fs.rename(temporary, destination).pipe(
              Effect.uninterruptible,
              Effect.onError(() =>
                fs.rename(displaced, destination).pipe(Effect.uninterruptible, Effect.orDie),
              ),
            );
            yield* fs.remove(displaced, { recursive: true }).pipe(Effect.uninterruptible);
            const adoptedHash = yield* hasher.hash(destination);
            if (adoptedHash !== desiredHash)
              return yield* new ProjectionFailure({
                message: `Post-adoption hash verification failed for ${skill.skillId} on ${harness}`,
              });
            projection.status = "installed";
            projection.observed_digest = adoptedHash;
            return projection;
          }
          projection.status = "conflicted";
          projection.observed_digest = observed;
          return settled();
        }
        if (observed !== markerExpectedHash(marker)) {
          const variant = join(
            context.variantsPath,
            harness,
            yield* projectionName(skill.name),
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
          projection.status = "installed";
          projection.observed_digest = observed;
          return settled();
        }
        const markerNext = ownershipMarker(request, projectionId, desiredHash);
        yield* fs.writeFileString(
          join(temporary, ".skit-ownership.json"),
          `${JSON.stringify(markerNext, null, 2)}\n`,
          { mode: 0o600 },
        );
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* fs.remove(destination, { recursive: true });
            yield* fs.rename(temporary, destination);
          }),
        );
        const nextHash = yield* hasher.hash(destination);
        if (nextHash !== desiredHash)
          return yield* new ProjectionFailure({
            message: `Post-write hash verification failed for ${skill.skillId} on ${harness}`,
          });
        projection.status = "installed";
        projection.observed_digest = nextHash;
        return projection;
      }
      const marker = ownershipMarker(request, projectionId, desiredHash);
      yield* fs.writeFileString(
        join(temporary, ".skit-ownership.json"),
        `${JSON.stringify(marker, null, 2)}\n`,
        { mode: 0o600 },
      );
      if (yield* fs.exists(destination))
        return yield* new ProjectionFailure({
          message: `Projection appeared before materialization: ${destination}`,
        });
      yield* fs.rename(temporary, destination).pipe(Effect.uninterruptible);
      return yield* Effect.gen(function* () {
        const observed = yield* hasher.hash(destination);
        if (observed !== desiredHash)
          return yield* new ProjectionFailure({
            message: `Post-write hash verification failed for ${skill.skillId} on ${harness}`,
          });
        projection.status = "installed";
        projection.observed_digest = observed;
        return projection;
      });
    }),
  );
});

/**
 * Whether a recorded Projection is still the one SKIT wrote.
 *
 * This is the custody question `retire` asks immediately before displacing anything, separated so
 * a caller can also ask it *first*. A batch may use that to refuse before changing any derived
 * directory; otherwise its authoritative state remains unchanged until the final publication.
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
): Effect.fn.Return<
  RetireProjectionResult,
  ProjectionRetireConflict | OwnershipMarkerDisagrees | TreeError | PlatformError,
  TreeRequirements | TreeHasher
> {
  const fs = yield* FileSystem.FileSystem;
  const custody = yield* projectionCustodyEffect(projection);
  if (custody.kind === "absent") return { kind: "absent" as const };
  if (custody.kind === "conflicted") {
    if (onConflict === "report") return { kind: "conflicted" as const, observed: custody.observed };
    return yield* new ProjectionRetireConflict({ detail: conflictMessage });
  }
  // Intact means the Projection exists, so it has a path.
  const destination = projection.path;
  const { observed } = custody;
  yield* fs.remove(destination, { recursive: true }).pipe(Effect.uninterruptible);
  return {
    kind: "retired" as const,
    observed,
  };
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
  readonly rootFor: (harness: HarnessName) => string | undefined;
  readonly variantsPath: string;
}

const projectionName = Effect.fn("Projection.name")(function* (name: string) {
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

/** Owns one private candidate and publishes it once after all derived filesystem work succeeds. */
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
    readonly publish: (state: S) => Effect.Effect<void, PE, PR>;
  },
  stage: (mutation: ProjectionMutation<S>) => Effect.Effect<T, SE, SR>,
) {
  const candidate = structuredClone(loaded);
  const mutation: ProjectionMutation<S> = {
    state: candidate,
    project: Effect.fn("Projection.project")(function* (request) {
      const root = request.root ?? context.rootFor(request.harness);
      if (!root) return yield* new NoProjectionRoot({ harness: request.harness });
      yield* projectionName(request.skill.name);
      return yield* materializeProjectionEffect({ ...request, state: candidate }, context);
    }),
    retire: Effect.fn("Projection.retire")(function* (projection, onConflict, message) {
      const result = yield* retireProjectionEffect(projection, onConflict, message);
      return result.kind === "retired"
        ? { kind: "retired" as const, observed: result.observed }
        : result;
    }),
  };
  const value = yield* stage(mutation);
  yield* context.publish(candidate);
  return { state: candidate, value };
});
