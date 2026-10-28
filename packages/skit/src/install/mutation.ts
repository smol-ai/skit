import { copyLocalTree } from "../platform/copy-tree.js";
import { Data, Effect, FileSystem, Result, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { dirname, join, relative, resolve } from "node:path";
import {
  type OwnershipMarker,
  StoredOwnershipMarker,
  type InstallDestination,
  type Hash,
  type InvocationPolicy,
} from "../contracts.js";
import { LinkStat } from "../platform/link-stat.js";
import {
  applyInvocationPolicy,
  declaredInvocationIntent,
  overrideInvocationIntent,
  type InvocationIntent,
} from "./policy.js";
import { deterministicTreeHash } from "../artifact/skit.js";
import { TreeHasher } from "../artifact/tree-hasher.js";
import type { HarnessInvocationWriteFailure } from "../harnesses/write-invocation.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
import type { TreeError } from "../shared/tree-error.js";
import {
  ManageContentMismatch,
  ManageTargetChanged,
  NoSkillsDirectory,
  OwnershipMarkerDisagrees,
  UninstallConflict,
  SkillsDirectoryNotWritable,
  UnsafeInstalledSkillBackups,
  UnsafeInstalledSkillName,
} from "../failures.js";
import {
  type InstalledSkillId as InstalledSkillIdType,
  type SkillId as SkillIdType,
  type SkillVersionId as SkillVersionIdType,
} from "../library/entity-ids.js";
import type { InstalledSkill } from "../library/library-state.js";
import {
  globalEnabled,
  libraryStateRevision,
  type LibraryState,
} from "../library/library-state.js";
import { installedSkillSource } from "../library/installation/installed-skill-source.js";
import {
  backUpInstalledSkill,
  keepInstalledSkillBackup,
  losslessTree,
  pendingInstalledSkillBackups,
  installedSkillWorkDirectory,
} from "./backups.js";
import { ensureSkillsDirectoryWritable } from "./writable.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

const OwnershipMarkerDocument = Schema.fromJsonString(Schema.Unknown);

export type UninstallResult =
  | { kind: "absent" }
  | { kind: "conflicted"; observed: Hash }
  | { kind: "uninstalled"; observed: Hash };

export interface WriteInstalledSkillRequest {
  /** Installed-skill ownership coordinate and retained root, without a save contract. */
  installation: { readonly libraryPath: string };
  skill: {
    readonly skillId: SkillIdType;
    readonly skillVersionId: SkillVersionIdType;
    readonly name: string;
    readonly contentHash: Hash;
  };
  target: InstallDestination;
  /** An enclosing native batch can declare distinct roots on one target. */
  root?: string;
  sourcePath: string;
  shared?: Array<{ from: string; to: string }>;
  declaredInvocation?: InvocationPolicy;
  invocationIntent: InvocationIntent;
  previous?: InstalledSkill;
  /** Exact preview evidence authorizing managing of this unmanaged target. */
  manage?: ManageApproval;
  /**
   * Take ownership of an unmanaged directory at the destination when it already holds exactly the
   * bytes this install would write. Adopting it adds SKIT's marker and changes nothing else.
   */
  manageIdentical?: boolean;
  /** Exact preview evidence authorizing a changed managed installed skill as the selected Version. */
  replacement?: {
    installedSkillId: InstalledSkillIdType;
    currentHash: Hash;
    marker: OwnershipMarker;
  };
  state: InstalledSkillState;
  identity: {
    readonly installedSkillId: InstalledSkillIdType;
    readonly skillId: SkillIdType;
    readonly skillVersionId: SkillVersionIdType;
  };
  /** Explicit enable may recreate an absent installed skill suppressed by native deletion. */
  restoreNativeDeletion?: boolean;
  installedAt: string;
}

export interface InstalledSkillState extends LibraryState {}

/** An installed skill could not be written or verified. */
export class InstalledSkillFailure
  extends Data.TaggedError("InstalledSkillFailure")<{
    message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Run `skit doctor` to inspect the installed skill, then retry.";
}

function exists(path: string): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(path);
  });
}

/** Shared owned copy policy, with the installer's existing unsupported-entry failure. */
const copyInstalledSkillTree = Effect.fn("Install.copyTree")((from: string, to: string) =>
  copyLocalTree(from, to, undefined, false).pipe(
    Effect.catchTag("TreeError", (error) =>
      Effect.fail(new InstalledSkillFailure({ message: error.message })),
    ),
  ),
);

const copySkill = Effect.fn("Install.copySkill")(function* (
  request: Pick<
    WriteInstalledSkillRequest,
    "sourcePath" | "shared" | "target" | "declaredInvocation" | "invocationIntent"
  > & { destination: string; libraryPath: string },
): Effect.fn.Return<
  void,
  InstalledSkillFailure | HarnessInvocationWriteFailure,
  FileSystem.FileSystem | LinkStat
> {
  const fs = yield* FileSystem.FileSystem;
  // overwrite stays false: copying onto an existing tree must fail, not merge.
  yield* copyInstalledSkillTree(request.sourcePath, request.destination);
  for (const mapping of request.shared ?? []) {
    const target = resolve(request.destination, mapping.to);
    if (relative(request.destination, target).startsWith(".."))
      return yield* new InstalledSkillFailure({
        message: `Shared mapping target escaped child: ${mapping.to}`,
      });
    yield* fs.makeDirectory(dirname(target), { recursive: true }).pipe(Effect.uninterruptible);
    yield* copyInstalledSkillTree(join(request.libraryPath, mapping.from), target);
  }
  yield* applyInvocationPolicy(
    request.destination,
    request.target,
    request.declaredInvocation,
    request.invocationIntent,
  );
});

/** Rebuild one former copy into caller-owned staging, using the same byte owner as installing. */
export const prepareInstalledSkillRebuild = Effect.fn("Install.prepareRebuild")(function* (
  state: LibraryState,
  originalsPath: string,
  installedSkill: InstalledSkill,
  invocationIntent: InvocationIntent,
) {
  const target = installedSkill.destination;
  if (target === "legacy")
    return yield* new InstalledSkillFailure({
      message: "Legacy installed skills require their original saved bytes",
    });
  const skill = state.skills.find((item) => item.skill_id === installedSkill.skill_id);
  const version = skill?.versions.find(
    (item) => item.skill_version_id === installedSkill.skill_version_id,
  );
  if (!skill || !version)
    return yield* new InstalledSkillFailure({
      message: "Former installed skill has no retained Skill Version",
    });
  const source = yield* installedSkillSource(state, originalsPath, skill, version);
  if (source.kind !== "source") return yield* new InstalledSkillFailure({ message: source.detail });
  return {
    collectionVersionPath: source.libraryPath,
    build: Effect.fn("Install.rebuildBytes")(function* (destination: string) {
      // Retained bytes may have changed since review; validate them again before reading.
      const current = yield* installedSkillSource(state, originalsPath, skill, version);
      if (current.kind !== "source")
        return yield* new InstalledSkillFailure({ message: current.detail });
      yield* copySkill({
        ...current,
        libraryPath: current.libraryPath,
        destination,
        target,
        invocationIntent,
      });
    }),
  };
});

export function readOwnershipMarker(
  path: string,
): Effect.Effect<OwnershipMarker | null, PlatformError, FileSystem.FileSystem> {
  return inspectOwnershipMarker(path).pipe(
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

const markerExpectedHash = (marker: OwnershipMarker): Hash => marker.expected_hash;

// Ownership is the installed skill and Skill; a new selected Version is an ordinary rewrite, and the
// expected-digest check below is what detects local edits.
const markerMatches = (
  marker: OwnershipMarker,
  request: Pick<WriteInstalledSkillRequest, "identity">,
) =>
  marker.installed_skill_id === request.identity.installedSkillId &&
  marker.skill_id === request.identity.skillId;

const sameMarker = (left: OwnershipMarker, right: OwnershipMarker) =>
  left.installed_skill_id === right.installed_skill_id &&
  left.skill_id === right.skill_id &&
  left.skill_version_id === right.skill_version_id &&
  left.expected_hash === right.expected_hash;

const ownershipMarker = (
  request: WriteInstalledSkillRequest,
  installedSkillId: InstalledSkillIdType,
  expectedHash: Hash,
): OwnershipMarker => ({
  schemaVersion: 5,
  installed_skill_id: request.identity.installedSkillId,
  skill_id: request.identity.skillId,
  skill_version_id: request.identity.skillVersionId,
  expected_hash: expectedHash,
});

export function inspectOwnershipMarker(
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
export function expectedInstalledSkillHashResult(
  installedSkill: InstalledSkill,
  marker: OwnershipMarker | null,
): Result.Result<Hash, OwnershipMarkerDisagrees> {
  if (marker && installedSkill.expected_hash !== markerExpectedHash(marker))
    return Result.fail(
      new OwnershipMarkerDisagrees({
        skillId: installedSkill.skill_id,
        target: installedSkill.destination,
      }),
    );
  return Result.succeed(installedSkill.expected_hash);
}

/** Moves an owned copy into a pending backup for the mutation that will settle it. */
type BackUp = (
  installedSkill: InstalledSkill,
  action: "replace" | "retire",
) => Effect.Effect<void, UnsafeInstalledSkillBackups | PlatformError, TreeRequirements>;

const writeInstalledSkill = Effect.fn("Install.write")(function* (
  request: WriteInstalledSkillRequest,
  context: NativeInstalledSkillContext & { readonly backUp: BackUp },
): Effect.fn.Return<
  { installedSkill: InstalledSkill; changed: boolean },
  InstalledSkillMutationError,
  TreeRequirements | TreeHasher
> {
  let changed = false;
  const fs = yield* FileSystem.FileSystem;
  const hasher = yield* TreeHasher;
  const { installation, skill, target, previous } = request;
  const root = request.root ?? context.rootFor(target);
  if (!root) return yield* Effect.fail(new NoSkillsDirectory({ target }));
  yield* ensureSkillsDirectoryWritable(root);
  const destination = join(root, yield* installedSkillName(skill.name));
  const installedSkillId = request.identity.installedSkillId;
  const prior = previous?.installed_skill_id === installedSkillId ? previous : undefined;
  const workDirectory = yield* installedSkillWorkDirectory(root);
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
      const desiredHash = yield* deterministicTreeHash(temporary);
      const installedSkill: InstalledSkill = {
        installed_skill_id: installedSkillId,
        skill_id: request.identity.skillId,
        skill_version_id: request.identity.skillVersionId,
        destination: target,
        root,
        path: destination,
        expected_hash: desiredHash,
        status: "pending",
        installed_at: request.installedAt,
      };
      const settled = () => installedSkill;
      /**
       * Commit ownership of the selected Version and verify it. `marker` stamps equal bytes in place,
       * keeping whatever the hash leaves out; `replace` first moves the owned original into a
       * pending backup; `install` refuses a destination that appeared since it was observed.
       */
      const commit = Effect.fn("Install.commit")(function* (
        mode: "marker" | "replace" | "install",
        verification: string,
      ) {
        const marker = `${JSON.stringify(ownershipMarker(request, installedSkillId, desiredHash), null, 2)}\n`;
        // Stamping through a link would claim a directory outside the root, so a linked
        // destination is replaced instead, and the link itself kept in a backup.
        const inPlace =
          mode === "marker" &&
          (yield* (yield* LinkStat).lstat(destination)).type !== "SymbolicLink";
        if (inPlace) {
          // Stage outside the installed tree so an interrupted write cannot leave hash drift.
          const markerTemporary = join(staging, "ownership.json");
          yield* fs.writeFileString(markerTemporary, marker, { mode: 0o600, flag: "wx" });
          yield* fs
            .rename(markerTemporary, join(destination, ".skit-ownership.json"))
            .pipe(Effect.uninterruptible);
        } else {
          yield* fs.writeFileString(join(temporary, ".skit-ownership.json"), marker, {
            mode: 0o600,
          });
          if (mode !== "install") yield* context.backUp(installedSkill, "replace");
          else if (yield* fs.exists(destination))
            return yield* new InstalledSkillFailure({
              message: `Installed skill appeared before installing: ${destination}`,
            });
          yield* fs.rename(temporary, destination).pipe(Effect.uninterruptible);
        }
        const currentHash = yield* hasher.hash(destination);
        if (currentHash !== desiredHash)
          return yield* new InstalledSkillFailure({
            message: `Post-${verification} hash verification failed for ${skill.skillId} at ${target}`,
          });
        changed = true;
        return { ...installedSkill, status: "installed" as const, current_hash: currentHash };
      });
      const nativeDeletion =
        !request.restoreNativeDeletion &&
        prior?.status === "suppressed" &&
        prior.suppression_reason === "native_delete" &&
        !(yield* exists(destination)) &&
        !(yield* installedSkillDisplaced(prior));
      if (nativeDeletion) {
        installedSkill.status = "suppressed";
        installedSkill.suppression_reason = "native_delete";
        installedSkill.suppressed_at = prior.suppressed_at;
        installedSkill.current_hash = prior.current_hash;
        return settled();
      }
      if (yield* exists(destination)) {
        const markerInspection = yield* inspectOwnershipMarker(destination);
        const marker = markerInspection.kind === "valid" ? markerInspection.marker : null;
        const currentHash = yield* hasher.hash(destination);
        const realDestination = yield* fs
          .realPath(destination)
          .pipe(Effect.orElseSucceed(() => resolve(destination)));
        const managePaths = request.manage
          ? [request.manage.path, ...(request.manage.equalPaths ?? [])]
          : [];
        let manageMatchesDestination = false;
        for (const path of managePaths)
          manageMatchesDestination ||=
            (yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => resolve(path)))) ===
            realDestination;
        const replacementMatches =
          request.replacement !== undefined &&
          request.replacement.installedSkillId === installedSkillId &&
          request.replacement.currentHash === currentHash &&
          currentHash === desiredHash &&
          marker !== null &&
          sameMarker(marker, request.replacement.marker);
        if (replacementMatches) return yield* commit("marker", "replacement");
        if (!marker || !markerMatches(marker, request)) {
          if (markerInspection.kind === "absent" && request.manage && manageMatchesDestination) {
            if (currentHash !== request.manage.currentHash)
              return yield* new ManageTargetChanged({ path: destination });
            if (currentHash !== desiredHash)
              return yield* new ManageContentMismatch({ path: destination });
            // Equal content is managed in place, keeping every entry the hash leaves out.
            return yield* commit("marker", "adoption");
          }
          // A destination inside a checkout is repository-owned even when `.git` is above the
          // skill directory (including worktrees, whose `.git` is a file).
          let repositoryOwned = false;
          if (request.manageIdentical) {
            let directory = realDestination;
            while (true) {
              if (yield* exists(join(directory, ".git"))) {
                repositoryOwned = true;
                break;
              }
              const parent = dirname(directory);
              if (parent === directory) break;
              directory = parent;
            }
          }
          // Unasked managing only takes a folder that is nothing more than the copy: the hash
          // leaves out `.git`, so a checkout with the same files, and its history, would
          // otherwise become SKIT's to move aside on disable.
          if (
            markerInspection.kind === "absent" &&
            request.manageIdentical &&
            !repositoryOwned &&
            currentHash === desiredHash &&
            (yield* (yield* LinkStat).lstat(destination)).type === "Directory" &&
            !(yield* exists(join(destination, ".git"))) &&
            !(yield* exists(join(destination, "skit.remote.json")))
          )
            return yield* commit("marker", "adoption");
          installedSkill.status = "conflicted";
          installedSkill.current_hash = currentHash;
          return settled();
        }
        if (currentHash !== markerExpectedHash(marker)) {
          const variant = join(
            context.variantsPath,
            target,
            yield* installedSkillName(skill.name),
            currentHash.slice(7),
          );
          if (!(yield* exists(variant))) {
            yield* fs.makeDirectory(dirname(variant), { recursive: true });
            const variantStaging = yield* fs.makeTempDirectoryScoped({
              directory: dirname(variant),
              prefix: ".skit-stage-",
            });
            const temporaryVariant = join(variantStaging, "variant");
            yield* copyInstalledSkillTree(destination, temporaryVariant);
            yield* fs.rename(temporaryVariant, variant).pipe(Effect.uninterruptible);
          }
          return {
            ...installedSkill,
            expected_hash: prior?.expected_hash ?? markerExpectedHash(marker),
            status: "conflicted" as const,
            current_hash: currentHash,
          };
        }
        if (currentHash === desiredHash) {
          if (marker.skill_version_id !== request.identity.skillVersionId)
            return yield* commit("marker", "marker");
          installedSkill.status = "installed";
          installedSkill.current_hash = currentHash;
          return settled();
        }
        return yield* commit("replace", "write");
      }
      return yield* commit("install", "write");
    }),
  ).pipe(Effect.map((installedSkill) => ({ installedSkill, changed })));
});

/**
 * Whether a recorded installed skill is still the one SKIT wrote.
 *
 * This is the ownership question `retire` asks immediately before displacing anything, separated so
 * a caller can also ask it *first*. A batch may use that to refuse before changing any derived
 * directory.
 */
export const inspectInstalledSkill = Effect.fn("Install.inspectInstalledSkill")(function* (
  installedSkill: InstalledSkill,
): Effect.fn.Return<
  | { kind: "absent" }
  | { kind: "intact"; observed: Hash; marker: OwnershipMarker }
  | { kind: "conflicted"; observed: Hash },
  OwnershipMarkerDisagrees | TreeError | PlatformError,
  TreeRequirements | TreeHasher
> {
  const destination = installedSkill.path;
  if (!(yield* exists(destination))) return { kind: "absent" as const };
  const marker = yield* readOwnershipMarker(destination);
  const observed = yield* (yield* TreeHasher).hash(destination);
  if (
    !marker ||
    marker.skill_id !== installedSkill.skill_id ||
    marker.installed_skill_id !== installedSkill.installed_skill_id ||
    observed !== markerExpectedHash(marker)
  )
    return { kind: "conflicted" as const, observed };
  return { kind: "intact" as const, observed, marker };
});

const uninstallSkill = Effect.fn("Install.uninstall")(function* (
  installedSkill: InstalledSkill,
  onConflict: "throw" | "report",
  conflictMessage: string,
  backUp: BackUp,
): Effect.fn.Return<
  UninstallResult,
  | UninstallConflict
  | OwnershipMarkerDisagrees
  | UnsafeInstalledSkillBackups
  | TreeError
  | PlatformError,
  TreeRequirements | TreeHasher
> {
  const ownership = yield* inspectInstalledSkill(installedSkill);
  if (ownership.kind === "absent") return { kind: "absent" as const };
  if (ownership.kind === "conflicted") {
    if (onConflict === "report")
      return { kind: "conflicted" as const, observed: ownership.observed };
    return yield* new UninstallConflict({ detail: conflictMessage });
  }
  const { observed } = ownership;
  yield* backUp(installedSkill, "retire");
  return {
    kind: "uninstalled" as const,
    observed,
  };
});

/**
 * Whether a pending backup holds the very copy a recorded installed skill describes, so it still
 * explains that installed skill's absence. A backup of an earlier copy explains nothing about a later one.
 */
export const installedSkillDisplaced = Effect.fn("Install.displaced")(function* (
  installedSkill: InstalledSkill,
) {
  for (const backup of yield* pendingInstalledSkillBackups(installedSkill)) {
    const marker = yield* readOwnershipMarker(backup);
    if (
      marker?.installed_skill_id === installedSkill.installed_skill_id &&
      marker.expected_hash === installedSkill.expected_hash
    )
      return true;
  }
  return false;
});

/**
 * Whether a backup is exactly what SKIT would write again, proven only from `prior`, the Library
 * state the mutation loaded: the backup's marker must name the recorded installed skill and Version, that
 * Version's retained original must be intact, and restaging it under a recorded invocation policy
 * must reproduce every name, type, mode and byte. Anything short of that proof keeps the backup.
 */
const reproducible = Effect.fn("Install.reproducible")(function* (
  backup: string,
  prior: LibraryState,
  originalsPath: string,
  installedSkillId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const recorded = prior.installed_skills.find(
    (item) => item.installed_skill_id === installedSkillId,
  );
  const marker = yield* readOwnershipMarker(backup);
  if (
    recorded === undefined ||
    marker?.installed_skill_id !== recorded.installed_skill_id ||
    marker.skill_id !== recorded.skill_id ||
    marker.skill_version_id !== recorded.skill_version_id
  )
    return false;
  const skill = prior.skills.find((item) => item.skill_id === recorded.skill_id);
  const version = skill?.versions.find(
    (item) => item.skill_version_id === recorded.skill_version_id,
  );
  const target = recorded.destination;
  // A former per-Harness root's transforms are no longer known, so its copy cannot be restaged.
  if (skill === undefined || version === undefined || target === "legacy") return false;
  const source = yield* installedSkillSource(prior, originalsPath, skill, version);
  const expected = yield* losslessTree(backup);
  if (source.kind === "invalid" || expected === undefined) return false;
  const policies = new Set(
    [globalEnabled(prior), ...prior.repositories].flatMap((list) => {
      const policy = list.invocation_policies?.[skill.skill_id];
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
        return yield* losslessTree(destination);
      }),
    );
    if (restaged === expected) return true;
  }
  return false;
});
/**
 * Unmanaged copies the operator approved managing in place: the selected copy, and any
 * copies with identical bytes already at another target's destination. Each is managed only while
 * its content still hashes to `currentHash`, so managing one adds SKIT's marker and nothing else.
 */
export interface ManageApproval {
  readonly path: string;
  readonly equalPaths?: readonly string[];
  readonly currentHash: Hash;
}

export type InstalledSkillMutationError =
  | ManageContentMismatch
  | ManageTargetChanged
  | InstalledSkillFailure
  | NoSkillsDirectory
  | SkillsDirectoryNotWritable
  | UnsafeInstalledSkillName
  | OwnershipMarkerDisagrees
  | UninstallConflict
  | UnsafeInstalledSkillBackups
  | HarnessInvocationWriteFailure
  | TreeError
  | PlatformError;

export interface NativeInstalledSkillContext {
  readonly rootFor: (target: InstallDestination) => string | undefined;
  readonly variantsPath: string;
}

export const installedSkillName = Effect.fn("Install.name")(function* (name: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return yield* new UnsafeInstalledSkillName({ name });
  return name;
});
export interface InstalledSkillMutation<S extends InstalledSkillState = InstalledSkillState> {
  readonly state: S;
  readonly install: (
    request: Omit<WriteInstalledSkillRequest, "state">,
  ) => Effect.Effect<InstalledSkill, InstalledSkillMutationError, TreeRequirements | TreeHasher>;
  readonly uninstall: (
    installedSkill: InstalledSkill,
    onConflict: "throw" | "report",
    conflictMessage: string,
  ) => Effect.Effect<
    Exclude<UninstallResult, { kind: "uninstalled" }> | { kind: "uninstalled"; observed: Hash },
    InstalledSkillMutationError,
    TreeRequirements | TreeHasher
  >;
}

/**
 * Owns one private candidate and saves it once after all derived filesystem work succeeds.
 *
 * Nothing is rolled back. A failed batch instead saves what its verified filesystem work left
 * behind: each copy it wrote and verified as installed, and each it moved aside, leaving nothing in
 * its place, as `pending`, so an absence SKIT caused is never read as a native deletion. A write
 * that fails verification saves nothing for its installed skill. After a save, pending backups of
 * every installed skill the batch touched are settled: discarded only when the loaded state proves the
 * retained original reproduces them, otherwise kept. A batch that leaves the state as loaded, wrote
 * nothing and has no backup to settle saves nothing.
 */
export const withInstalledSkillMutation = Effect.fn("Install.mutate")(function* <
  S extends InstalledSkillState,
  T,
  PE,
  PR,
  SE,
  SR,
>(
  loaded: S,
  context: NativeInstalledSkillContext & {
    /** Where retained originals live, to prove a backup reproducible before discarding it. */
    readonly originalsPath: string;
    /** Save `next` only if the Library is still `base`, the state this mutation loaded. */
    readonly save: (next: S, base: S) => Effect.Effect<void, PE, PR>;
  },
  stage: (mutation: InstalledSkillMutation<S>) => Effect.Effect<T, SE, SR>,
) {
  const fs = yield* FileSystem.FileSystem;
  const candidate = structuredClone(loaded);
  const changedInstalledSkills = new Set<string>();
  const touched = new Map<string, InstalledSkill>();
  const onDisk = new Map<string, InstalledSkill>();
  const backUp: BackUp = (installedSkill, action) =>
    backUpInstalledSkill(installedSkill, action).pipe(
      Effect.map(() => {
        onDisk.set(installedSkill.installed_skill_id, { ...installedSkill, status: "pending" });
      }),
    );
  const mutation: InstalledSkillMutation<S> = {
    state: candidate,
    install: Effect.fn("Install.install")(function* (request) {
      const root = request.root ?? context.rootFor(request.target);
      if (!root) return yield* new NoSkillsDirectory({ target: request.target });
      yield* installedSkillName(request.skill.name);
      const installedSkillId = request.identity.installedSkillId;
      const result = yield* writeInstalledSkill(
        { ...request, state: candidate },
        { ...context, backUp },
      ).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            const displaced = onDisk.get(installedSkillId);
            // An unverified successor now stands where the original was: never call it pending.
            if (displaced !== undefined && (yield* fs.exists(displaced.path)))
              onDisk.delete(installedSkillId);
          }).pipe(Effect.orElseSucceed(() => onDisk.delete(installedSkillId))),
        ),
      );
      touched.set(installedSkillId, result.installedSkill);
      if (result.changed) {
        changedInstalledSkills.add(installedSkillId);
        onDisk.set(installedSkillId, result.installedSkill);
      }
      return result.installedSkill;
    }),
    uninstall: Effect.fn("Install.uninstall")(function* (installedSkill, onConflict, message) {
      touched.set(installedSkill.installed_skill_id, installedSkill);
      const result = yield* uninstallSkill(installedSkill, onConflict, message, backUp);
      return result.kind === "uninstalled"
        ? { kind: "uninstalled" as const, observed: result.observed }
        : result;
    }),
  };
  const saveOnDisk = Effect.suspend(() => {
    if (onDisk.size === 0) return Effect.void;
    const next = structuredClone(loaded);
    for (const installedSkill of onDisk.values()) {
      const index = next.installed_skills.findIndex(
        (item) => item.installed_skill_id === installedSkill.installed_skill_id,
      );
      if (index >= 0) next.installed_skills[index] = installedSkill;
      else next.installed_skills.push(installedSkill);
    }
    return context.save(next, loaded);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Installed skills changed, but the Library could not record them", cause),
    ),
  );
  const value = yield* stage(mutation).pipe(Effect.onError(() => saveOnDisk));
  const pending = yield* Effect.forEach([...touched.values()], (installedSkill) =>
    Effect.map(pendingInstalledSkillBackups(installedSkill), (backups) =>
      backups.map((backup) => ({ backup, installedSkillId: installedSkill.installed_skill_id })),
    ),
  ).pipe(
    Effect.map((backups) => backups.flat()),
    Effect.catchCause((cause) =>
      Effect.as(Effect.logWarning("Installed-skill backups stayed pending", cause), []),
    ),
  );
  // The save also proves `loaded` is still the Library's, which settling a backup relies on.
  if (
    onDisk.size > 0 ||
    pending.length > 0 ||
    libraryStateRevision(candidate) !== libraryStateRevision(loaded)
  )
    yield* context.save(candidate, loaded);
  yield* Effect.gen(function* () {
    for (const { backup, installedSkillId } of pending)
      if (
        yield* reproducible(backup, loaded, context.originalsPath, installedSkillId).pipe(
          Effect.orElseSucceed(() => false),
        )
      )
        yield* fs.remove(backup, { recursive: true });
      else yield* keepInstalledSkillBackup(backup);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Library changed, but installed-skill backups stayed pending", cause),
    ),
  );
  return { state: candidate, value, installed: changedInstalledSkills.size };
});
