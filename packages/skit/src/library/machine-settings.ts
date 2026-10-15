import { Effect, FileSystem, Schema } from "effect";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { writeJsonAtomicEffect } from "../platform/atomic-write.js";
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
const mutate = Effect.fn("MachineSettings.mutate")(function* (
  home: string,
  displayName: string | undefined,
  change: (
    settings: Settings,
  ) =>
    | Pick<Settings, "discoveryRoots" | "repositories" | "repositoryDecisionsInitialized">
    | undefined,
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
      yield* writeJsonAtomicEffect(prior.path, document);
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
export const updateDiscovery = Effect.fn("MachineSettings.updateDiscovery")(function* (
  home: string,
  choices: {
    readonly discoveryRoots?: readonly string[];
    readonly repositories?: readonly MachineRepositoryDecision[];
    readonly displayName?: string;
  },
) {
  return yield* mutate(home, choices.displayName, (prior) => {
    const decisions = new Map(
      prior.repositories.map((entry) => [resolve(entry.path), entry.status]),
    );
    for (const entry of choices.repositories ?? [])
      decisions.set(resolve(entry.path), entry.status);
    return {
      repositoryDecisionsInitialized: true,
      discoveryRoots: [
        ...new Set((choices.discoveryRoots ?? prior.discoveryRoots).map((path) => resolve(path))),
      ].sort(),
      repositories: [...decisions]
        .map(([path, status]) => ({ path, status }))
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
