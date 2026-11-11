import type { DiscoveryRestoreConflict } from "./machine-settings-conflicts.js";
import { Effect, FileSystem, Option, Schema } from "effect";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { writeJsonAtomic } from "../platform/atomic-write.js";
import { hashParts } from "../artifact/descriptor.js";
import { Hash } from "../shared/hash.js";
import { canonicalJson } from "../shared/json.js";
import { LibraryChanged } from "./failures.js";
import { Unusable, SetupNotRecorded } from "./machine-settings-failures.js";
export { Unusable } from "./machine-settings-failures.js";
import { makeMachineId, type OperationId } from "./entity-ids.js";
import {
  currentMachineDocument,
  emptyMachineDocument,
  MachineDocument,
  supportedMachineDocumentVersions,
  MachineDocumentV6,
  CurrentMachineDocument,
  type DiscoveryEvidence,
  type MachineRepositoryDecision,
} from "./machine-document.js";
import { withLock as withHomeLock } from "../platform/home-lock.js";
import { withLibraryStateReplacement } from "./store/writer-lock.js";

/** Current settings, without exposing the persisted document version. */
export type Settings = Omit<CurrentMachineDocument, "schemaVersion"> & { readonly path: string };

/** The caller may retain typed inverse evidence while this owner still holds publication authority. */
export type BeforeSave<E = never, R = never> = (
  before: Settings,
  after: Settings,
) => Effect.Effect<void, E, R>;

const settingsAt = (path: string, document: CurrentMachineDocument): Settings => {
  const { schemaVersion: _version, ...settings } = document;
  return { path, ...settings };
};

/** Missing settings read as empty; reading an older version never writes a migration. */
export const read = Effect.fn("MachineSettings.read")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(resolve(home), "machine.json");
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.undefined
          : Effect.fail(new Unusable({ path, reason: { _tag: "ReadFailed", failure: error } })),
      ),
    );
  if (text === undefined) return settingsAt(path, emptyMachineDocument());
  const invalid = (failure: Schema.SchemaError) =>
    new Unusable({ path, reason: { _tag: "InvalidData", failure } });
  const input = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError(invalid),
  );
  const supported = supportedMachineDocumentVersions;
  if (
    Schema.is(Schema.Struct({ schemaVersion: Schema.Int }))(input) &&
    !supported.includes(input.schemaVersion)
  )
    return yield* new Unusable({
      path,
      reason: { _tag: "UnsupportedVersion", version: input.schemaVersion, supported },
    });
  const document = yield* Schema.decodeUnknownEffect(MachineDocument)(input).pipe(
    Effect.mapError(invalid),
  );
  return settingsAt(path, document);
});

/** Own the complete read-modify-write, including fibers sharing an inherited root lock. */
const mutate = Effect.fn("MachineSettings.mutate")(function* <E = never, R = never>(
  home: string,
  displayName: string | undefined,
  change: (
    settings: Settings,
  ) =>
    | Pick<Settings, "discoveryRoots" | "repositories" | "repositoryDecisionsInitialized">
    | undefined,
  beforeSave?: BeforeSave<E, R>,
  /** The setup this save belongs to: the same write records what it changed, for undo. */
  operationId?: OperationId,
  undoOperationId?: string,
) {
  return yield* withLibraryStateReplacement(
    home,
    Effect.gen(function* () {
      const prior = yield* read(home);
      const changed =
        change(prior) ??
        (undoOperationId !== undefined && !prior.undoneSetups.includes(undoOperationId)
          ? prior
          : undefined);
      if (changed === undefined) return prior;
      const machineId = prior.machineId ?? makeMachineId();
      const evidence = (
        discoveryRoots: readonly string[],
        identity: Settings["machineId"],
      ): DiscoveryEvidence => ({
        discoveryRoots: [...discoveryRoots],
        ...(identity === undefined ? {} : { machineId: identity }),
      });
      const document = yield* MachineDocumentV6.makeEffect(
        currentMachineDocument({
          machineId,
          undoneSetups:
            undoOperationId === undefined
              ? [...prior.undoneSetups]
              : [...new Set([...prior.undoneSetups, undoOperationId])],
          displayName: displayName ?? prior.displayName ?? hostname(),
          repositoryDecisionsInitialized: changed.repositoryDecisionsInitialized,
          discoveryRoots: [...changed.discoveryRoots],
          repositories: [...changed.repositories],
          // A later setup's record replaces the earlier one: once it saves, the earlier setup's
          // discovery folders are no longer what undo would find.
          setups:
            operationId === undefined
              ? [...prior.setups]
              : [
                  {
                    operationId,
                    before: evidence(prior.discoveryRoots, prior.machineId),
                    expectedAfter: evidence(changed.discoveryRoots, machineId),
                  },
                ],
        }),
      ).pipe(
        Effect.mapError(
          (failure) =>
            new Unusable({
              path: prior.path,
              reason: { _tag: "InvalidData", failure: new Schema.SchemaError(failure) },
            }),
        ),
      );
      if (beforeSave)
        yield* beforeSave(
          structuredClone(prior),
          structuredClone(settingsAt(prior.path, document)),
        );
      yield* writeJsonAtomic(prior.path, document);
      return settingsAt(prior.path, document);
    }),
  );
});

/** Preserve an existing identity without rewriting its document, including legacy documents. */
export const ensureIdentity = Effect.fn("MachineSettings.ensureIdentity")(function* (home: string) {
  const settings = yield* mutate(home, undefined, (prior) =>
    prior.machineId === undefined ? prior : undefined,
  );
  // A successful mutation either found or persisted an identity.
  return yield* Effect.fromNullishOr(settings.machineId).pipe(Effect.orDie);
});

/**
 * Replace supplied roots and merge supplied decisions, preserving all other settings. With a
 * setup's `operationId`, the same write records the discovery folders before and after, for undo.
 */
export const updateDiscovery = Effect.fn("MachineSettings.updateDiscovery")(function* <
  E = never,
  R = never,
>(
  home: string,
  choices: {
    readonly discoveryRoots?: readonly string[];
    readonly repositories?: readonly MachineRepositoryDecision[];
    readonly displayName?: string;
  },
  beforeSave?: BeforeSave<E, R>,
  operationId?: OperationId,
) {
  return yield* mutate(
    home,
    choices.displayName,
    (prior) => {
      const decisions = new Map(
        prior.repositories.map((entry) => [resolve(entry.path), entry.status]),
      );
      for (const entry of choices.repositories ?? [])
        decisions.set(resolve(entry.path), entry.status);
      return {
        // Saving roots alone decides nothing about repositories. Marking decisions initialized here
        // would make later scans inspect only watched repositories, of which there are none.
        repositoryDecisionsInitialized:
          prior.repositoryDecisionsInitialized || (choices.repositories?.length ?? 0) > 0,
        discoveryRoots: [
          ...new Set((choices.discoveryRoots ?? prior.discoveryRoots).map((path) => resolve(path))),
        ].sort(),
        repositories: [...decisions]
          .map(([path, status]) => ({ path, status }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      };
    },
    beforeSave,
    operationId,
  );
});

export const setRepositoryDecision = Effect.fn("MachineSettings.setRepositoryDecision")(function* (
  home: string,
  repository: string,
  status: "watched" | "ignored" | undefined,
) {
  return yield* mutate(home, undefined, (prior) => {
    const path = resolve(repository);
    const decisions = new Map(
      prior.repositories.map((entry) => [resolve(entry.path), entry.status]),
    );
    if (status === undefined) decisions.delete(path);
    else decisions.set(path, status);
    return {
      repositoryDecisionsInitialized: true,
      discoveryRoots: prior.discoveryRoots,
      repositories: [...decisions]
        .map(([path, status]) => ({ path, status }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  });
});

/** Save only a reviewed inverse of discovery settings, preserving this machine's provenance. */
export const restoreDiscovery = Effect.fn("MachineSettings.restoreDiscovery")(function* <
  E = never,
  R = never,
>(
  home: string,
  expected: Settings,
  restored: Pick<
    Settings,
    "discoveryRoots" | "repositories" | "repositoryDecisionsInitialized" | "displayName"
  >,
  beforeSave?: BeforeSave<E, R>,
  undoOperationId?: string,
) {
  const approved = structuredClone(expected);
  const choice = structuredClone(restored);
  return yield* mutate(
    home,
    choice.displayName,
    () => ({
      discoveryRoots: choice.discoveryRoots,
      repositories: choice.repositories,
      repositoryDecisionsInitialized: choice.repositoryDecisionsInitialized,
    }),
    (before, after) =>
      Effect.gen(function* () {
        if (canonicalJson(before) !== canonicalJson(approved))
          return yield* new LibraryChanged({ path: before.path });
        if (beforeSave) yield* beforeSave(before, after);
      }),
    undefined,
    undoOperationId,
  );
});

/** What the setup `operationId` recorded about the discovery folders it saved, if it did. */
export const setupRecord = Effect.fn("MachineSettings.setupRecord")(function* (
  home: string,
  operationId: OperationId,
) {
  return Option.fromUndefinedOr(
    (yield* read(home)).setups.find((record) => record.operationId === operationId),
  );
});

/** No record of the setup to undo: it saved no discovery folders, or a later setup has since. */
/**
 * Put back the discovery folders the setup `operationId` replaced. Refuses with `LibraryChanged`
 * unless they and this machine's identity are still what that setup saved. Never touches the
 * identity, the name or repository decisions. The same write records completion; once recorded,
 * another restore succeeds without writing, including after independent settings changes.
 */
export const restoreSetupDiscovery = Effect.fn("MachineSettings.restoreSetupDiscovery")(function* (
  home: string,
  operationId: OperationId,
) {
  return yield* withHomeLock(
    home,
    Effect.gen(function* () {
      const current = yield* read(home);
      if (current.undoneSetups.includes(operationId)) return "unchanged" as const;
      if (!current.setups.some((saved) => saved.operationId === operationId))
        return yield* new SetupNotRecorded({ path: current.path, operationId });
      return yield* applyRestoreDiscovery(home, yield* planRestoreDiscovery(home, operationId));
    }),
  );
});

const equal = (left: unknown, right: unknown) =>
  canonicalJson(left ?? null) === canonicalJson(right ?? null);

/** Plain review data; apply recomputes it before saving anything. */
export interface DiscoveryRestorePlan {
  readonly operationId: string;
  readonly planId: Hash;
  readonly before: Settings;
  readonly after: Settings;
  readonly conflicts: readonly DiscoveryRestoreConflict[];
  readonly changed: boolean;
  readonly recorded: boolean;
}

/** Preview only this owner's part of an undo, from its saved setup record. */
export const planRestoreDiscovery = Effect.fn("MachineSettings.planRestoreDiscovery")(function* (
  home: string,
  operationId: string,
) {
  const before = yield* read(home);
  const completed = before.undoneSetups.includes(operationId);
  const record = before.setups.find((saved) => saved.operationId === operationId);
  let after = before;
  let conflicts: readonly DiscoveryRestoreConflict[] = [];
  if (!completed && record !== undefined) {
    if (before.machineId !== record.expectedAfter.machineId)
      conflicts = [{ _tag: "MachineChanged" }];
    else if (!equal(before.discoveryRoots, record.before.discoveryRoots)) {
      if (!equal(before.discoveryRoots, record.expectedAfter.discoveryRoots))
        conflicts = [{ _tag: "DiscoveryFoldersChanged" }];
      else after = { ...before, discoveryRoots: [...record.before.discoveryRoots] };
    }
  }
  const plan = {
    operationId,
    before,
    after,
    conflicts,
    changed: !equal(before.discoveryRoots, after.discoveryRoots),
    recorded: !completed && record !== undefined,
  };
  return { ...plan, planId: hashParts([canonicalJson(plan)]) } satisfies DiscoveryRestorePlan;
});

/** Revalidate the whole review and save its inverse and completion in one machine.json write. */
export const applyRestoreDiscovery = Effect.fn("MachineSettings.applyRestoreDiscovery")(function* (
  home: string,
  plan: DiscoveryRestorePlan,
) {
  const approved = structuredClone(plan);
  return yield* withHomeLock(
    home,
    Effect.gen(function* () {
      const current = yield* planRestoreDiscovery(home, approved.operationId);
      if (!equal(current, approved) || current.conflicts.length)
        return yield* new LibraryChanged({ path: current.before.path });
      if (!current.recorded) return "unchanged" as const;
      // There is no identity to preserve or settings to restore on an untouched machine.
      if (!current.changed && current.before.machineId === undefined) return "unchanged" as const;
      yield* restoreDiscovery(home, current.before, current.after, undefined, current.operationId);
      return current.changed ? ("restored" as const) : ("unchanged" as const);
    }),
  );
});
