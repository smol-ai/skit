import { Effect, FileSystem, Option, Schema } from "effect";
import type { Digest } from "effect/crypto";
import type { HttpClient } from "effect/http";
import type { TreeRequirements } from "../../../platform/tree-requirements.js";
import {
  InvalidLibraryState,
  type LibraryBusy,
  type ContentAddressCollision,
} from "../../../failures.js";
import type { PlatformError } from "effect/PlatformError";
import type { TreeError } from "../../../shared/tree-error.js";
import type { SnapshotArchiveInvalid } from "../../snapshot-archive-universal.js";
import { withLock as withHomeLock } from "../../../platform/home-lock.js";
import { canonicalJson } from "../../../shared/json.js";
import { sha256Hash } from "../../../shared/hash.js";
import type { Hash } from "../../../vocabulary.js";
import { collectionVersionPath, originalTreeHash } from "../../collection-version.js";
import {
  planCollectionVersions,
  type CollectionVersionPlan,
} from "../../collection-version-plan.js";
import {
  importCanBeRefetched,
  LibraryManifest,
  type SnapshotArchive,
} from "../../library-contracts.js";
import type { LibraryState } from "../../library-state.js";
import { normalizeLibraryManifest } from "../../manifest.js";
import type { CollectionVersionId } from "../../entity-ids.js";
import type { RestoreProgress } from "../../restore-progress.js";
import type { Snapshot } from "../../snapshot.js";
import { planningState } from "../../reviewed-plan.js";
import { readSnapshotArchive, verifySnapshotArchive } from "../../snapshot-archive.js";
import { libraryOriginalsPath, libraryStatePath } from "../../store/library-store.js";
import {
  completeRestoreArchives,
  retainRestoreArchives,
  restoredState,
  RestoreInvalid,
  type SourceRestoreInvalid,
} from "./restore.js";

export interface StagedContent {
  readonly manifestDigest: Hash;
  readonly reusable: readonly Hash[];
  readonly retained: readonly Hash[];
  readonly missing: readonly CollectionVersionId[];
  readonly state: LibraryState;
}

export type ContentSource<E = never, R = never> = {
  readonly download?: (hash: Hash) => Effect.Effect<SnapshotArchive, E, R>;
  readonly registry: { readonly origin: string; readonly token: Option.Option<string> };
  /** Existing restoration facts; the frontend owns their rendering. */
  readonly progress?: RestoreProgress;
} & (
  | { readonly localArchives: readonly SnapshotArchive[]; readonly plan?: never }
  | { readonly plan: CollectionVersionPlan; readonly localArchives?: never }
);

export const planContent = Effect.fn("Library.content.plan")(function* (
  home: string,
  target: LibraryManifest,
  localArchives: readonly SnapshotArchive[],
) {
  const manifest = yield* Schema.decodeUnknownEffect(LibraryManifest, {
    onExcessProperty: "error",
  })(structuredClone(target)).pipe(
    Effect.mapError(
      () =>
        new InvalidLibraryState({ path: libraryStatePath(home), detail: "invalid content target" }),
    ),
  );
  return yield* planCollectionVersions(normalizeLibraryManifest(manifest), {
    originalsPath: libraryOriginalsPath(home),
    localArchives: structuredClone(localArchives),
  });
});

export const inspectContent = Effect.fn("Library.content.inspect")(function* (
  home: string,
  snapshot: Snapshot,
) {
  const state = yield* planningState(home, snapshot);
  const originalsPath = libraryOriginalsPath(home);
  for (const tree of state.collection_versions) {
    const path = collectionVersionPath(originalsPath, tree.hash);
    const hash = yield* originalTreeHash(path).pipe(
      Effect.catchTag("TreeError", (error) =>
        Effect.fail(new InvalidLibraryState({ path, detail: error.message })),
      ),
    );
    if (hash !== tree.hash) return { _tag: "Changed" as const, hash: tree.hash };
  }
  return { _tag: "Intact" as const };
});

export const packContent = Effect.fn("Library.content.pack")(function* (
  home: string,
  snapshot: Snapshot,
) {
  const state = yield* planningState(home, snapshot);
  const originalsPath = libraryOriginalsPath(home);
  const archives = new Map<Hash, SnapshotArchive>();
  // Check every reference, even when several Collections share the same retained bytes.
  for (const tree of state.collection_versions) {
    const path = collectionVersionPath(originalsPath, tree.hash);
    const archive = yield* readSnapshotArchive(path).pipe(
      Effect.catchTag("TreeError", (error) =>
        Effect.fail(new InvalidLibraryState({ path, detail: error.message })),
      ),
    );
    if (archive.digest !== tree.hash)
      return yield* new InvalidLibraryState({
        path,
        detail: `retained bytes changed: ${tree.hash}`,
      });
    yield* verifySnapshotArchive(archive).pipe(
      Effect.catchTag("Library.SnapshotArchiveInvalid", (error) =>
        Effect.fail(new InvalidLibraryState({ path, detail: error.message })),
      ),
    );
    archives.set(archive.digest, archive);
  }
  return [...archives.values()];
});

/** Resolve outside the writer; publish immutable content under Library's writer. Never saves state. */
export const stageContent = Effect.fn("Library.content.stage")(function* <E = never, R = never>(
  home: string,
  target: LibraryManifest,
  source: ContentSource<E, R>,
): Effect.fn.Return<
  StagedContent,
  ContentStageError | E,
  R | TreeRequirements | Digest.Digest | HttpClient.HttpClient
> {
  const originalsPath = libraryOriginalsPath(home);
  const fs = yield* FileSystem.FileSystem;
  const manifest = normalizeLibraryManifest(
    yield* Schema.decodeUnknownEffect(LibraryManifest, { onExcessProperty: "error" })(
      structuredClone(target),
    ).pipe(Effect.mapError(() => new RestoreInvalid({ detail: "invalid target manifest" }))),
  );
  const manifestDigest = yield* sha256Hash(new TextEncoder().encode(canonicalJson(manifest)));
  const plan =
    source.plan === undefined
      ? yield* planCollectionVersions(manifest, {
          originalsPath,
          localArchives: structuredClone(source.localArchives),
        })
      : structuredClone(source.plan);
  const unavailable = new Set<Hash>(source.download === undefined ? plan.download : []);
  for (const id of plan.reacquire) {
    if (
      !manifest.imports.some(
        (item) => item.collection_version_id === id && importCanBeRefetched(item),
      )
    ) {
      const tree = manifest.collection_versions.find((item) => item.collection_version_id === id);
      if (tree !== undefined) unavailable.add(tree.hash);
    }
  }
  const missing = manifest.collection_versions
    .filter((tree) => unavailable.has(tree.hash))
    .map((tree) => tree.collection_version_id);
  if (missing.length)
    return {
      manifestDigest,
      reusable: [],
      retained: [],
      missing,
      state: yield* restoredState(manifest),
    } satisfies StagedContent;
  const hashes = [...new Set(manifest.collection_versions.map((tree) => tree.hash))];
  const existing = new Set<Hash>();
  for (const hash of hashes)
    if (yield* fs.exists(collectionVersionPath(originalsPath, hash))) existing.add(hash);
  const options = {
    originalsPath,
    registryBaseUrl: source.registry.origin,
    registryToken: Option.getOrUndefined(source.registry.token),
    ...(source.progress === undefined ? {} : { progress: source.progress }),
    ...(source.download === undefined ? {} : { download: source.download }),
  };
  const available = yield* completeRestoreArchives(manifest, plan, options);
  const { state } = yield* withHomeLock(
    home,
    Effect.scoped(retainRestoreArchives(manifest, available, options)),
  );
  return {
    manifestDigest,
    reusable: hashes.filter((hash) => existing.has(hash)),
    retained: hashes.filter((hash) => !existing.has(hash)),
    missing: [],
    state,
  } satisfies StagedContent;
});
export type ContentStageError =
  | RestoreInvalid
  | SourceRestoreInvalid
  | SnapshotArchiveInvalid
  | ContentAddressCollision
  | PlatformError
  | TreeError
  | LibraryBusy;
