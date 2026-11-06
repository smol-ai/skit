import { Cause, Effect, FileSystem, Predicate } from "effect";
import { isPlatformError } from "effect/PlatformError";
import { dirname, join, resolve } from "node:path";
import * as Library from "../../library.js";
import { emptyLibraryState, type LibraryState } from "../../library-state.js";
import { loadLibrary, writeLibrary } from "../../store/library-store.js";
import { latestSourceImport, type LibrarySubject } from "../../subject-resolution.js";
import { sourceLocator } from "../../../sources/resolve.js";
import { isSkitFailure } from "../../../shared/failure.js";
import type { Hash } from "../../../shared/hash.js";
import type { SkitSource } from "../../library-contracts.js";
import type { SourceDiscoveryDiagnostic } from "../../../sources/source-diagnostics.js";
import {
  resolveUpdate,
  selectSubjects,
  skillChanges,
  type LibraryProgressReporter,
} from "./source-updates.js";

/** The existing acquisition adapter's imported-content facts; no storage or lifecycle is exposed. */
export interface SourceUpdateAdapters<E, R, F extends { readonly remediation: string }> {
  readonly importSource: (
    input: SkitSource,
    previousSkillPaths: readonly string[],
  ) => Effect.Effect<
    {
      readonly snapshot_digest: Hash;
      readonly collection_version_id: string;
      readonly diagnostics?: readonly SourceDiscoveryDiagnostic[];
    },
    E,
    R
  >;
  readonly progress: LibraryProgressReporter;
  readonly classifyFailure: (cause: Cause.Cause<unknown>) => F;
}

/** Canonicalize the existing ancestor too, since a failed write's destination may not exist. */
const canonicalStoragePath = Effect.fn("Library.canonicalStoragePath")(function* (input: string) {
  const fs = yield* FileSystem.FileSystem;
  let path = resolve(input);
  const suffix: string[] = [];
  while (true) {
    const canonical = yield* fs
      .realPath(path)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
    if (canonical !== undefined) return join(canonical, ...suffix);
    const parent = dirname(path);
    if (parent === path) return resolve(input);
    suffix.unshift(path.slice(parent.length).replace(/^[/\\]/, ""));
    path = parent;
  }
});

/**
 * Own one update through scope cleanup. Recoverable failures report persisted evidence;
 * shared-storage failures, interruption and programming defects remain failures of the action.
 */
const updateCollection = Effect.fn("Library.updateCollection")(function* <
  E,
  R,
  F extends { readonly remediation: string },
>(
  home: string,
  state: LibraryState,
  before: LibrarySubject,
  adapters: SourceUpdateAdapters<E, R, F>,
) {
  const progress = adapters.progress;
  const library = yield* Library.Service;
  const storeHome = yield* canonicalStoragePath(home);
  let phase: "source" | "install" = "source";
  let source = before.label;
  let sourceImported = false;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const { priorTree, input } = yield* resolveUpdate(state, before);
      source = sourceLocator(input);
      const subject = { id: before.subjectId, label: before.label };
      const imported = yield* progress.around(
        { kind: "source", subject },
        adapters
          .importSource(
            input,
            priorTree.members.map((member) => member.source_path),
          )
          .pipe(Effect.provideService(Library.Service, library)),
        (value) => ({
          kind: "source-inspected",
          changed: value.snapshot_digest !== priorTree.hash,
        }),
      );
      sourceImported = true;
      const changed = imported.snapshot_digest !== priorTree.hash;
      let installed = 0;
      const collectionId =
        before.kind === "collection" ? before.collection.collection_id : before.skill.collection_id;
      // Reconcile even when the Source is current: a previous run may have retained
      // this snapshot before installing failed or temporary-source cleanup interrupted it.
      {
        const current = yield* library.read;
        phase = "install";
        const installedSkillUpdate = yield* progress.around(
          { kind: "install", subject },
          Effect.gen(function* () {
            const outcome = (yield* library.apply({
              _tag: "Apply",
              plan: yield* library.plan({ _tag: "Update" }, { base: current }),
            })).result;
            return {
              installed:
                outcome._tag === "Applied"
                  ? outcome.copies.filter((copy) => copy._tag === "Installed").length
                  : 0,
            };
          }),
          (value) => ({ kind: "installed-skills-updated", installed: value.installed }),
        );
        installed = installedSkillUpdate.installed;
      }
      const after = yield* loadLibrary(home);
      const collectionVersion = after.collection_versions.find(
        (tree) => tree.collection_version_id === imported.collection_version_id,
      );
      return {
        subject_id: before.subjectId,
        subject_kind: before.kind,
        previous_collection_version_id: priorTree.collection_version_id,
        selected_collection_version_id: imported.collection_version_id,
        snapshot_digest: imported.snapshot_digest,
        changed,
        installed: installed,
        label: before.label,
        ...("diagnostics" in imported && imported.diagnostics?.length
          ? { diagnostics: imported.diagnostics }
          : {}),
        ...skillChanges(
          state,
          collectionId,
          priorTree.members,
          (collectionVersion?.members ?? []).map((member) => ({
            source_path: member.source_path,
            artifact_hash: member.artifact_hash,
            name:
              after.skills.find(
                (skill) =>
                  skill.collection_id === collectionId && skill.path === member.source_path,
              )?.name ?? member.source_path,
          })),
        ),
      };
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        // Recover at the Collection boundary after its scopes close. Programming defects,
        // interruption, and failures accessing shared Library storage remain fatal.
        const recovery = yield* Effect.forEach(cause.reasons, (reason) =>
          Effect.gen(function* () {
            if (Cause.isInterruptReason(reason)) return false;
            const error = Cause.isFailReason(reason) ? reason.error : reason.defect;
            if (
              Predicate.isTagged(error, "InvalidLibraryState") ||
              Predicate.isTagged(error, "HomeBusy") ||
              Predicate.isTagged(error, "LibraryChanged") ||
              Predicate.isTagged(error, "Library.StalePlan") ||
              Predicate.isTagged(error, "ContentAddressCollision") ||
              Predicate.isTagged(error, "MachineSettingsUnusable")
            )
              return false;
            if (isPlatformError(error)) {
              const path =
                "pathOrDescriptor" in error.reason ? error.reason.pathOrDescriptor : undefined;
              if (typeof path === "string") {
                const canonical = yield* canonicalStoragePath(path).pipe(
                  Effect.catch(() => Effect.failCause(cause)),
                );
                if (canonical === storeHome || canonical.startsWith(`${storeHome}/`)) return false;
              }
              return (
                Cause.isFailReason(reason) || error.reason.method === "makeTempDirectoryScoped"
              );
            }
            // When a finalizer dies, Effect converts every typed error in the cause to a defect.
            // A named SKIT failure is still a Collection failure; programming defects never are.
            return Cause.isFailReason(reason) || isSkitFailure(error);
          }),
        );
        if (!recovery.every(Boolean)) return yield* Effect.failCause(cause);
        return yield* Effect.gen(function* () {
          // Source publication can succeed before its temporary checkout fails to close.
          // Inspect persisted evidence rather than claiming that such an update was rolled back.
          if (!sourceImported) {
            const current = yield* loadLibrary(home);
            const previous = latestSourceImport(state, before);
            const latest = latestSourceImport(current, before);
            sourceImported = latest !== undefined && latest.import_id !== previous?.import_id;
          }
          const error = adapters.classifyFailure(cause);
          return {
            status: "failed" as const,
            subject_id: before.subjectId,
            subject_kind: before.kind,
            label: before.label,
            source,
            phase,
            source_imported: sourceImported,
            error: sourceImported
              ? {
                  ...error,
                  remediation: `${error.remediation} Update this Collection again to retry it and update its installed skills.`,
                }
              : error,
          };
        });
      }),
    ),
  );
});

/** One owner and one batch action; Collection failures stay local, shared-storage failures stop it. */
export const updateSources = Effect.fn("Library.updateSources")(function* <
  E,
  R,
  F extends { readonly remediation: string },
>(home: string, query: string | undefined, adapters: SourceUpdateAdapters<E, R, F>) {
  const library = yield* Library.Service;
  return yield* writeLibrary(
    home,
    Effect.gen(function* () {
      const snapshot = yield* library.read;
      const state = snapshot._tag === "Present" ? snapshot.state : emptyLibraryState();
      const selected = yield* selectSubjects(state, query);
      return yield* Effect.forEach(selected, (subject) =>
        updateCollection(home, state, subject, adapters),
      );
    }),
  );
}, Effect.scoped);
