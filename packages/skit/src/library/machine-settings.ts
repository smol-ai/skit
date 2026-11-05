import { Effect, FileSystem, Option, Schema } from "effect";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { writeJsonAtomic } from "../platform/atomic-write.js";
import { hashParts } from "../artifact/descriptor.js";
import { Hash } from "../vocabulary.js";
import { canonicalJson } from "../shared/json.js";
import { LibraryChanged } from "../failures.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { MachineId, makeMachineId, type OperationId } from "./entity-ids.js";
import {
  currentMachineDocument,
  emptyMachineDocument,
  MachineDocumentJson,
  MachineDocumentV7,
  CurrentMachineDocument,
  type DiscoveryEvidence,
  type MachineRepositoryDecision,
  type MachineSettingsSetupRecord,
} from "./machine-document.js";
import { withLock as withHomeLock } from "../platform/home-lock.js";
import { withLibraryStateReplacement } from "./store/writer-lock.js";

/** Current settings, without exposing the persisted document version. */
export type Settings = Omit<CurrentMachineDocument, "schemaVersion"> & { readonly path: string };

export class Unusable
  extends Schema.TaggedError<Unusable>()("MachineSettingsUnusable", {
    path: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get remediation(): string {
    return `Correct or move aside ${this.path}, then run \`skit setup\` again.`;
  }
  get message(): string {
    return `SKIT machine configuration is invalid: ${this.path}`;
  }
}

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
          ? Effect.succeed(undefined)
          : Effect.fail(new Unusable({ path })),
      ),
    );
  const document =
    text === undefined
      ? emptyMachineDocument()
      : yield* Schema.decodeUnknownEffect(MachineDocumentJson)(text).pipe(
          Effect.mapError(() => new Unusable({ path })),
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
      const document = yield* MachineDocumentV7.makeEffect(
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
      ).pipe(Effect.mapError(() => new Unusable({ path: prior.path })));
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
export class SetupNotRecorded
  extends Schema.TaggedError<SetupNotRecorded>()("MachineSettings.SetupNotRecorded", {
    path: Schema.String,
    operationId: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "NOT_FOUND" as const;
  readonly remediation = "Review the discovery folders with `skit setup`.";
  get message(): string {
    return `No discovery folders are recorded for setup ${this.operationId} in ${this.path}`;
  }
}

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

export type { MachineSettingsSetupRecord };

export const SetupDiscoverySettings = Schema.Struct({
  discoveryRoots: CurrentMachineDocument.fields.discoveryRoots,
  repositories: CurrentMachineDocument.fields.repositories,
  initialized: Schema.Boolean,
  displayName: Schema.NullOr(Schema.NonEmptyString),
});
export type SetupDiscoverySettings = typeof SetupDiscoverySettings.Type;
export const setupDiscoverySettings = (settings: Settings): SetupDiscoverySettings => ({
  discoveryRoots: [...settings.discoveryRoots],
  repositories: structuredClone(settings.repositories),
  initialized: settings.repositoryDecisionsInitialized,
  displayName: settings.displayName ?? null,
});

const equal = (left: unknown, right: unknown) =>
  canonicalJson(left ?? null) === canonicalJson(right ?? null);

/** A later repository decision is independent of the paths setup touched. Identity stays local. */
export const reverseSetupDiscovery = (
  settings: Settings,
  before: SetupDiscoverySettings,
  expected: SetupDiscoverySettings,
) => {
  const conflicts: string[] = [];
  const restore = <A>(label: string, prior: A, after: A, current: A): A => {
    if (equal(prior, after) || equal(current, prior)) return current;
    if (equal(current, after)) return prior;
    conflicts.push(label);
    return current;
  };
  const discoveryRoots = restore(
    "discovery roots",
    before.discoveryRoots,
    expected.discoveryRoots,
    settings.discoveryRoots,
  );
  const repositories = new Map(settings.repositories.map((item) => [item.path, item.status]));
  const old = new Map(before.repositories.map((item) => [item.path, item.status]));
  const after = new Map(expected.repositories.map((item) => [item.path, item.status]));
  for (const path of new Set([...old.keys(), ...after.keys()])) {
    const status = restore(
      `repository decision ${path}`,
      old.get(path),
      after.get(path),
      repositories.get(path),
    );
    if (status === undefined) repositories.delete(path);
    else repositories.set(path, status);
  }
  const initialized = [...repositories.keys()].some((path) => !old.has(path) && !after.has(path))
    ? settings.repositoryDecisionsInitialized
    : restore(
        "repository discovery initialization",
        before.initialized,
        expected.initialized,
        settings.repositoryDecisionsInitialized,
      );
  // A newly created identity's default name is provenance, not a prior user setting to erase.
  const displayName =
    before.displayName === null
      ? settings.displayName
      : restore(
          "machine display name",
          before.displayName,
          expected.displayName,
          settings.displayName ?? null,
        );
  const next = {
    ...settings,
    discoveryRoots: [...discoveryRoots],
    repositories: [...repositories]
      .map(([path, status]) => ({ path, status }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    repositoryDecisionsInitialized: initialized,
    ...(displayName === null || displayName === undefined ? {} : { displayName }),
  };
  return {
    settings: next,
    conflicts,
    changed: !equal(setupDiscoverySettings(settings), setupDiscoverySettings(next)),
  };
};

/** Machine-owned evidence carried by a pre-state.json setup journal. */
export const LegacySetupDiscovery = Schema.Struct({
  before: SetupDiscoverySettings,
  machineId: Schema.NullOr(MachineId),
  changes: Schema.Array(
    Schema.Struct({
      before: SetupDiscoverySettings,
      after: SetupDiscoverySettings,
      machineId: Schema.NullOr(MachineId),
      confirmed: Schema.Boolean,
    }),
  ),
});
export interface LegacySetupDiscovery extends Schema.Schema.Type<typeof LegacySetupDiscovery> {}

/** Plain review data; apply recomputes it before saving anything. */
export interface DiscoveryRestorePlan {
  readonly operationId: string;
  readonly planId: Hash;
  readonly legacy?: LegacySetupDiscovery;
  readonly before: Settings;
  readonly after: Settings;
  readonly conflicts: readonly string[];
  readonly changed: boolean;
  readonly recorded: boolean;
}

/** Preview only this owner's part of an undo. A legacy journal is evidence, never a writer. */
export const planRestoreDiscovery = Effect.fn("MachineSettings.planRestoreDiscovery")(function* (
  home: string,
  operationId: string,
  legacy?: LegacySetupDiscovery,
) {
  const before = yield* read(home);
  const completed = before.undoneSetups.includes(operationId);
  const record = before.setups.find((saved) => saved.operationId === operationId);
  let after = before;
  let conflicts: readonly string[] = [];
  if (!completed && legacy !== undefined && record !== undefined) {
    conflicts = ["Legacy evidence cannot replace this setup's recorded machine settings"];
  } else if (!completed && legacy !== undefined) {
    const problems: string[] = [];
    const expectedMachine = legacy.changes.reduce(
      (id, change) => change.machineId,
      legacy.machineId,
    );
    if (expectedMachine !== null && before.machineId !== expectedMachine)
      problems.push("Setup belongs to a different machine identity");
    let expected = legacy.before;
    for (const change of legacy.changes) {
      const current = setupDiscoverySettings(before);
      const applied = change.confirmed || equal(current, change.after);
      if (!applied && !equal(current, change.before))
        problems.push("Unconfirmed setup settings save differs from both recorded values");
      if (applied) expected = change.after;
    }
    const reversed = reverseSetupDiscovery(before, legacy.before, expected);
    after = reversed.settings;
    conflicts = [...problems, ...reversed.conflicts];
  } else if (!completed && record !== undefined) {
    if (before.machineId !== record.expectedAfter.machineId)
      conflicts = ["Setup belongs to a different machine identity"];
    else if (!equal(before.discoveryRoots, record.before.discoveryRoots)) {
      if (!equal(before.discoveryRoots, record.expectedAfter.discoveryRoots))
        conflicts = ["Discovery folders changed after setup"];
      else after = { ...before, discoveryRoots: [...record.before.discoveryRoots] };
    }
  }
  const plan = {
    operationId,
    ...(legacy === undefined ? {} : { legacy: structuredClone(legacy) }),
    before,
    after,
    conflicts,
    changed: !equal(setupDiscoverySettings(before), setupDiscoverySettings(after)),
    recorded: !completed && (record !== undefined || legacy !== undefined),
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
      const current = yield* planRestoreDiscovery(home, approved.operationId, approved.legacy);
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
