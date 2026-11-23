import type { DiscoveryRestoreConflict } from "./machine-settings-conflicts.js";
import { Effect, FileSystem, Schema } from "effect";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { libraryDatabasePath, withLibraryDatabase } from "./store/database.js";
import { loadMachineRows, saveMachineRows } from "./store/machine-rows.js";
import { loadMachineSettings } from "./store/machine-file.js";
import { withDatabaseTransaction } from "./store/database.js";

import { hashParts } from "../artifact/descriptor.js";
import { Hash } from "../shared/hash.js";
import { canonicalJson } from "../shared/json.js";
import { LibraryChanged } from "./failures.js";
import { Unusable } from "./machine-settings-failures.js";
import { makeMachineId } from "./entity-ids.js";
import {
  emptyMachineDocument,
  CurrentMachineDocument,
  type DiscoveryEvidence,
  type MachineRepositoryDecision,
} from "./machine-document.js";

/** Current settings, without exposing the persisted document version. */
export type Settings = Omit<CurrentMachineDocument, "schemaVersion"> & { readonly path: string };

const settingsAt = (path: string, document: CurrentMachineDocument): Settings => {
  const { schemaVersion: _version, ...settings } = document;
  return { ...settings, path };
};

/** The store imports released files once; this owner reads current settings from rows. */
export const read = Effect.fn("MachineSettings.read")(function* (home: string) {
  return settingsAt(
    libraryDatabasePath(home),
    (yield* loadMachineSettings(home)) ?? emptyMachineDocument(),
  );
});

/** Read the saved identity without initializing machine settings or importing legacy files. */
export const readIdentity = Effect.fn("MachineSettings.readIdentity")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = libraryDatabasePath(home);
  if (!(yield* fs.exists(path))) return undefined;
  return (yield* withLibraryDatabase(path, loadMachineRows(path), true))?.machineId;
});

/** Own the complete read-modify-write, including fibers sharing an inherited root lock. */
const mutate = Effect.fn("MachineSettings.mutate")(function* (
  home: string,
  displayName: string | undefined,
  change: (
    settings: Settings,
  ) =>
    | Pick<Settings, "discoveryRoots" | "repositories" | "repositoryDecisionsInitialized">
    | undefined,
) {
  yield* loadMachineSettings(home, true);
  return yield* withDatabaseTransaction(
    home,
    Effect.gen(function* () {
      const stored = (yield* loadMachineSettings(home)) ?? emptyMachineDocument();
      const prior = settingsAt(libraryDatabasePath(home), stored);
      const changed = change(prior);
      if (changed === undefined) return prior;
      const kept = stored;
      const document = yield* CurrentMachineDocument.makeEffect({
        ...kept,
        schemaVersion: 5,
        machineId: prior.machineId ?? makeMachineId(),
        displayName: displayName ?? prior.displayName ?? hostname(),
        repositoryDecisionsInitialized: changed.repositoryDecisionsInitialized,
        discoveryRoots: [...changed.discoveryRoots],
        repositories: [...changed.repositories],
      }).pipe(
        Effect.mapError(
          (failure) =>
            new Unusable({
              path: prior.path,
              reason: { _tag: "InvalidData", failure: new Schema.SchemaError(failure) },
            }),
        ),
      );
      yield* saveMachineRows(prior.path, document);
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
 * Replace supplied roots and merge supplied decisions, preserving all other settings.
 * Setup records its discovery evidence while joining this owner's transaction.
 */
export const updateDiscovery = Effect.fn("MachineSettings.updateDiscovery")(function* (
  home: string,
  choices: {
    readonly discoveryRoots?: readonly string[];
    readonly repositories?: readonly MachineRepositoryDecision[];
    readonly displayName?: string;
  },
) {
  return yield* mutate(home, choices.displayName, (prior) => {
    const decisions = new Map(prior.repositories.map((entry) => [resolve(entry.path), entry]));
    for (const entry of choices.repositories ?? [])
      decisions.set(resolve(entry.path), { ...decisions.get(resolve(entry.path)), ...entry });
    return {
      // Saving roots alone decides nothing about repositories. Marking decisions initialized here
      // would make later scans inspect only watched repositories, of which there are none.
      repositoryDecisionsInitialized:
        prior.repositoryDecisionsInitialized || (choices.repositories?.length ?? 0) > 0,
      discoveryRoots: [
        ...new Set((choices.discoveryRoots ?? prior.discoveryRoots).map((path) => resolve(path))),
      ].sort(),
      repositories: [...decisions]
        .map(([path, entry]) => ({ ...entry, path }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  });
});

export const setRepositoryDecision = Effect.fn("MachineSettings.setRepositoryDecision")(function* (
  home: string,
  repository: string,
  status: "watched" | "ignored" | undefined,
) {
  return yield* mutate(home, undefined, (prior) => {
    const path = resolve(repository);
    const decisions = new Map(prior.repositories.map((entry) => [resolve(entry.path), entry]));
    if (status === undefined) decisions.delete(path);
    else decisions.set(path, { ...decisions.get(path), path, status });
    return {
      repositoryDecisionsInitialized: true,
      discoveryRoots: prior.discoveryRoots,
      repositories: [...decisions]
        .map(([path, entry]) => ({ ...entry, path }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  });
});

/** Apply the reviewed discovery inverse in the caller's undo transaction. */
export const applyDiscoveryUndo = Effect.fn("MachineSettings.applyDiscoveryUndo")(function* (
  home: string,
  change: {
    readonly beforeHash: Hash;
    readonly afterHash: Hash;
    readonly after: Pick<Settings, "discoveryRoots">;
  },
) {
  const path = libraryDatabasePath(home);
  yield* withDatabaseTransaction(
    home,
    Effect.gen(function* () {
      const document = yield* loadMachineSettings(home);
      const current = settingsAt(path, document ?? emptyMachineDocument());
      const hash = hashParts([canonicalJson(current)]);
      if (hash === change.afterHash) return;
      if (hash !== change.beforeHash || document === undefined)
        return yield* new LibraryChanged({ path });
      yield* saveMachineRows(path, {
        ...document,
        discoveryRoots: [...change.after.discoveryRoots],
      });
    }),
  );
});

const equal = (left: unknown, right: unknown) =>
  canonicalJson(left ?? null) === canonicalJson(right ?? null);

/** Plain review data; apply recomputes it before saving anything. */
interface DiscoveryRestorePlan {
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
  record?: { readonly before: DiscoveryEvidence; readonly expectedAfter: DiscoveryEvidence },
  completed = false,
) {
  const before = yield* read(home);
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
