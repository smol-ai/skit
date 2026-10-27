import { Effect, FileSystem, Schema } from "effect";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { writeJsonAtomic } from "../platform/atomic-write.js";
import { canonicalJson } from "../shared/json.js";
import { LibraryChanged } from "../failures.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { makeMachineId } from "./entity-ids.js";
import {
  currentMachineDocument,
  emptyMachineDocument,
  MachineDocumentJson,
  MachineDocumentV5,
  type CurrentMachineDocument,
  type MachineRepositoryDecision,
} from "./machine-document.js";
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
) {
  return yield* withLibraryStateReplacement(
    home,
    Effect.gen(function* () {
      const prior = yield* read(home);
      const changed = change(prior);
      if (changed === undefined) return prior;
      const document = yield* MachineDocumentV5.makeEffect(
        currentMachineDocument({
          machineId: prior.machineId ?? makeMachineId(),
          displayName: displayName ?? prior.displayName ?? hostname(),
          repositoryDecisionsInitialized: changed.repositoryDecisionsInitialized,
          discoveryRoots: [...changed.discoveryRoots],
          repositories: [...changed.repositories],
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

/** Replace supplied roots and merge supplied decisions, preserving all other settings. */
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
  );
});
