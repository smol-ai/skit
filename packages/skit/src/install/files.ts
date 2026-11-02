import { copyLocalTree } from "../platform/copy-tree.js";
import { Data, Effect, FileSystem, Result, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { dirname, join, relative, resolve } from "node:path";
import {
  OwnershipMarker,
  StoredOwnershipMarker,
  type InstallDestination,
  Hash,
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
import type { InstalledSkill } from "../library/library-state.js";
import { globalEnabled, type LibraryState } from "../library/library-state.js";
import { installedSkillSource } from "../library/installation/installed-skill-source.js";
import {
  losslessTree,
  pendingInstalledSkillBackups,
  installedSkillStagingDirectory,
} from "./backups.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";

const OwnershipMarkerDocument = Schema.fromJsonString(Schema.Unknown);

/** Where one copy's bytes come from, and how its Harness reads invocation metadata. */
export interface SkillSource {
  readonly sourcePath: string;
  readonly shared?: Array<{ from: string; to: string }>;
  readonly target: InstallDestination;
  readonly declaredInvocation?: InvocationPolicy;
  readonly invocationIntent: InvocationIntent;
}

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
  request: SkillSource & { destination: string; libraryPath: string },
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
  const skill = state.skills.find((item) => item.skill_id === installedSkill.skill_id);
  const version = skill?.versions.find(
    (item) => item.skill_version_id === installedSkill.skill_version_id,
  );
  if (!skill || !version)
    return yield* new InstalledSkillFailure({
      message: "Former installed skill has no stored Skill Version",
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

export const OwnershipMarkerInspection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("absent") }),
  Schema.Struct({ kind: Schema.Literal("invalid"), detail: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("valid"), marker: OwnershipMarker }),
]);
export type OwnershipMarkerInspection = typeof OwnershipMarkerInspection.Type;

export function parseOwnershipMarker(value: unknown): OwnershipMarkerInspection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { kind: "invalid", detail: "Ownership marker must be a JSON object" };
  const decoded = Schema.decodeUnknownOption(StoredOwnershipMarker)(value);
  if (decoded._tag === "Some") return { kind: "valid", marker: decoded.value };
  return { kind: "invalid", detail: "Ownership marker has invalid typed fields" };
}

const markerExpectedHash = (marker: OwnershipMarker): Hash => marker.expected_hash;

const sameMarker = (left: OwnershipMarker, right: OwnershipMarker) =>
  left.installed_skill_id === right.installed_skill_id &&
  left.skill_id === right.skill_id &&
  left.skill_version_id === right.skill_version_id &&
  left.expected_hash === right.expected_hash;

export function inspectOwnershipMarker(
  path: string,
): Effect.Effect<OwnershipMarkerInspection, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // A missing marker is absent; unreadable is a real failure; unparseable is invalid.
    const text = yield* fs
      .readFileString(join(path, ".skit-ownership.json"))
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));
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

/** Built bytes in staging on the root's own device, so installing them is a rename. */
export interface StagedInstalledSkill {
  readonly root: string;
  readonly staging: string;
  readonly path: string;
  readonly hash: Hash;
}

/** Build one copy's bytes into staging beside `root`. The staging lives as long as the Scope. */
export const stageInstalledSkill = Effect.fn("Install.stage")(function* (
  request: SkillSource & { readonly root: string; readonly libraryPath: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const staging = yield* fs.makeTempDirectoryScoped({
    directory: yield* installedSkillStagingDirectory(request.root),
    prefix: ".skit-stage-",
  });
  const path = join(staging, "skill");
  yield* copySkill({ ...request, destination: path });
  return {
    root: request.root,
    staging,
    path,
    hash: yield* deterministicTreeHash(path),
  } satisfies StagedInstalledSkill;
});

/**
 * Put staged bytes at `destination` under SKIT's marker and verify them. `manage` stamps the marker
 * on equal bytes in place, keeping whatever the hash leaves out; `replace` first runs `backUp` to
 * move the owned original into a pending backup; `install` refuses a destination that appeared since
 * it was inspected. A linked destination is never stamped through: it is replaced, its link backed up.
 */
export const commitInstalledSkill = Effect.fn("Install.commit")(function* (
  staged: StagedInstalledSkill,
  options: {
    readonly mode: "manage" | "replace" | "install";
    readonly destination: string;
    readonly marker: OwnershipMarker;
    readonly backUp: Effect.Effect<
      void,
      UnsafeInstalledSkillBackups | PlatformError,
      TreeRequirements
    >;
    readonly check: Effect.Effect<void, InstalledSkillMutationError, TreeRequirements>;
    readonly verification: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const { destination, marker } = options;
  yield* options.check;
  const text = `${JSON.stringify(marker, null, 2)}\n`;
  const inPlace =
    options.mode === "manage" && (yield* links.lstat(destination)).type !== "SymbolicLink";
  const committedIdentity = yield* links.identity.lstat(inPlace ? destination : staged.path);
  if (inPlace) {
    // Stage outside the installed tree so an interrupted write cannot leave hash drift.
    const markerTemporary = join(staged.staging, "ownership.json");
    yield* fs.writeFileString(markerTemporary, text, { mode: 0o600, flag: "wx" });
    yield* fs
      .rename(markerTemporary, join(destination, ".skit-ownership.json"))
      .pipe(Effect.uninterruptible);
  } else {
    yield* fs.writeFileString(join(staged.path, ".skit-ownership.json"), text, { mode: 0o600 });
    if (options.mode !== "install") yield* options.backUp;
    else if (yield* fs.exists(destination))
      return yield* new InstalledSkillFailure({
        message: `Installed skill appeared before installing: ${destination}`,
      });
    yield* fs.rename(staged.path, destination).pipe(Effect.uninterruptible);
  }
  const verifiedIdentity = yield* links.identity.lstat(destination);
  const verifiedMarker = yield* readOwnershipMarker(destination);
  if (
    verifiedIdentity.dev !== committedIdentity.dev ||
    verifiedIdentity.ino !== committedIdentity.ino ||
    verifiedMarker === null ||
    !sameMarker(verifiedMarker, marker)
  )
    return yield* new InstalledSkillFailure({
      message: `Installed skill identity or marker changed during commit: ${destination}`,
    });
  const hash = yield* (yield* TreeHasher).hash(destination);
  if (hash !== staged.hash)
    return yield* new InstalledSkillFailure({
      message: `Post-${options.verification} hash verification failed for ${marker.skill_id} at ${destination}`,
    });
  return { hash, identity: verifiedIdentity };
});

/** Copy an edited folder to `variant`, once, leaving the folder in place. */
export const keepInstalledSkillVariant = Effect.fn("Install.keepVariant")(function* (
  path: string,
  variant: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* exists(variant)) return;
  yield* fs.makeDirectory(dirname(variant), { recursive: true });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: dirname(variant),
        prefix: ".skit-stage-",
      });
      const temporary = join(staging, "variant");
      yield* copyInstalledSkillTree(path, temporary);
      yield* fs.rename(temporary, variant).pipe(Effect.uninterruptible);
    }),
  );
});

/** Where an edited copy's bytes are kept: one folder per destination, Skill and hash. */
export const installedSkillVariantPath = (
  variantsPath: string,
  target: InstallDestination,
  name: string,
  hash: Hash,
) => join(variantsPath, target, name, hash.slice("sha256:".length));

/**
 * Whether a recorded installed skill is still the one SKIT wrote.
 *
 * This is the ownership question uninstalling asks immediately before displacing anything, separated
 * so a caller can also ask it *first*. A batch may use that to refuse before changing any derived
 * directory.
 */
export const inspectInstalledSkill = Effect.fn("Install.inspectInstalledSkill")(function* (
  installedSkill: InstalledSkill,
): Effect.fn.Return<
  | { kind: "absent" }
  | { kind: "intact"; currentHash: Hash; marker: OwnershipMarker }
  | { kind: "conflicted"; currentHash: Hash },
  OwnershipMarkerDisagrees | TreeError | PlatformError,
  TreeRequirements | TreeHasher
> {
  const destination = installedSkill.path;
  if (!(yield* exists(destination))) return { kind: "absent" as const };
  const marker = yield* readOwnershipMarker(destination);
  const currentHash = yield* (yield* TreeHasher).hash(destination);
  if (
    !marker ||
    marker.skill_id !== installedSkill.skill_id ||
    marker.installed_skill_id !== installedSkill.installed_skill_id ||
    currentHash !== markerExpectedHash(marker)
  )
    return { kind: "conflicted" as const, currentHash };
  return { kind: "intact" as const, currentHash, marker };
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
 * Version's stored original must be intact, and restaging it under a recorded invocation policy
 * must reproduce every name, type, mode and byte. Anything short of that proof keeps the backup.
 */
export const reproducible = Effect.fn("Install.reproducible")(function* (
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
  if (skill === undefined || version === undefined) return false;
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
          "skill",
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
export const ManageApproval = Schema.Struct({
  path: Schema.String,
  equalPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  currentHash: Hash,
});
export type ManageApproval = typeof ManageApproval.Type;

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

export const installedSkillName = Effect.fn("Install.name")(function* (name: string) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return yield* new UnsafeInstalledSkillName({ name });
  return name;
});
