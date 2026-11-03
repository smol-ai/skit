import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer, Schema } from "effect";
import {
  BlobStore,
  DatabaseError,
  databaseError,
  type DatabaseSqlClient,
} from "../platform/cloudflare.js";
import { AuthorSkitDeleteResponse } from "@smolai/skit-core/universal/api";

const SkitVisibility = Schema.Struct({
  visibility: Schema.Literals(["public", "unlisted", "private"]),
});
const RevisionRow = Schema.Struct({ revision_id: Schema.String });
const ReleasePlanRow = Schema.Struct({
  release_id: Schema.String,
  version: Schema.String,
  visibility: Schema.Literals(["public", "unlisted", "private"]),
});
const DeletedReleaseRow = Schema.Struct({
  release_id: Schema.String,
  version: Schema.String,
  archive_object_key: Schema.String,
  published_at: Schema.String,
});

export interface SkitDeletePlan {
  readonly skit_id: string;
  readonly revisions: number;
  readonly releases: number;
  readonly release_versions: ReadonlyArray<string>;
}

export class DeleteRequiresPrivate extends Schema.TaggedError<DeleteRequiresPrivate>()(
  "SkitDelete.RequiresPrivate",
  {},
) {}

export interface SkitDeletionService {
  readonly plan: (
    owner: string,
    slug: string,
  ) => Effect.Effect<SkitDeletePlan | undefined, DatabaseError | DeleteRequiresPrivate>;
  readonly delete: (
    owner: string,
    slug: string,
  ) => Effect.Effect<AuthorSkitDeleteResponse, DatabaseError | DeleteRequiresPrivate>;
}
export class SkitDeletion extends Context.Service<SkitDeletion, SkitDeletionService>()(
  "@skit-server-effect/SkitDeletion",
) {}

export const layer = Layer.effect(
  SkitDeletion,
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    const sql: DatabaseSqlClient = yield* D1Client.D1Client;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));

    const plan = Effect.fn("SkitDeletion.plan")(function* (owner: string, slug: string) {
      const skitRows = yield* db(
        "find skit for deletion",
        sql`SELECT visibility FROM skits WHERE owner_slug = ${owner} AND skit_slug = ${slug}`,
      );
      if (skitRows[0] === undefined) return undefined;
      const skit = yield* Schema.decodeUnknownEffect(SkitVisibility)(skitRows[0]).pipe(
        Effect.mapError((cause) => new DatabaseError({ operation: "decode deletion skit", cause })),
      );
      const [revisionRows, releaseRows] = yield* Effect.all([
        db(
          "list skit revisions for deletion",
          sql`SELECT revision_id FROM revisions
              WHERE owner_slug = ${owner} AND skit_slug = ${slug}`,
        ),
        db(
          "list releases for deletion",
          sql`SELECT release_id, version, visibility FROM releases
              WHERE owner_slug = ${owner} AND skit_slug = ${slug}
              ORDER BY published_at, release_id`,
        ),
      ]);
      const [revisions, releases] = yield* Effect.all([
        Schema.decodeUnknownEffect(Schema.Array(RevisionRow))(revisionRows),
        Schema.decodeUnknownEffect(Schema.Array(ReleasePlanRow))(releaseRows),
      ]).pipe(
        Effect.mapError((cause) => new DatabaseError({ operation: "decode deletion plan", cause })),
      );
      if (
        skit.visibility !== "private" ||
        releases.some(({ visibility }) => visibility !== "private")
      )
        return yield* new DeleteRequiresPrivate();
      return {
        skit_id: `${owner}/${slug}`,
        revisions: revisions.length,
        releases: releases.length,
        release_versions: releases.map(({ version }) => version),
      };
    });

    const deleteSkit = Effect.fn("SkitDeletion.delete")(function* (owner: string, slug: string) {
      const guard = `EXISTS (
      SELECT 1 FROM skits
      WHERE owner_slug = ? AND skit_slug = ? AND visibility = 'private'
    ) AND NOT EXISTS (
      SELECT 1 FROM releases
      WHERE owner_slug = ? AND skit_slug = ? AND visibility != 'private'
    )`;
      const guardBindings = [owner, slug, owner, slug];
      const results = yield* db(
        "delete private skit",
        sql.batch([
          sql.unsafe(
            `DELETE FROM resource_grants WHERE resource_kind = 'release' AND resource_id IN
             (SELECT release_id FROM releases WHERE owner_slug = ? AND skit_slug = ?)
             AND ${guard}`,
            [owner, slug, ...guardBindings],
          ),
          sql.unsafe(
            `DELETE FROM resource_grants WHERE resource_kind = 'skit' AND resource_id = ?
             AND ${guard}`,
            [`${owner}/${slug}`, ...guardBindings],
          ),
          sql.unsafe(
            `DELETE FROM revision_parents WHERE owner_slug = ? AND skit_slug = ?
             AND ${guard}`,
            [owner, slug, ...guardBindings],
          ),
          sql.unsafe(
            `DELETE FROM revisions WHERE owner_slug = ? AND skit_slug = ?
             AND ${guard} RETURNING revision_id`,
            [owner, slug, ...guardBindings],
          ),
          // Trees are shared by hash, so only those no revision references any more go. Blobs
          // stay in R2.
          sql`DELETE FROM revision_tree_entries WHERE tree_hash IN (
                SELECT tree_hash FROM revision_trees t WHERE NOT EXISTS (
                  SELECT 1 FROM revisions r WHERE r.tree_hash = t.tree_hash))`,
          sql`DELETE FROM revision_trees WHERE NOT EXISTS (
                SELECT 1 FROM revisions r WHERE r.tree_hash = revision_trees.tree_hash)`,
          sql.unsafe(
            `DELETE FROM releases WHERE owner_slug = ? AND skit_slug = ?
             AND ${guard} RETURNING release_id, version, archive_object_key, published_at`,
            [owner, slug, ...guardBindings],
          ),
          sql`DELETE FROM skits WHERE owner_slug = ${owner} AND skit_slug = ${slug} AND visibility = 'private'
             AND NOT EXISTS (
               SELECT 1 FROM releases WHERE owner_slug = ${owner} AND skit_slug = ${slug}
             ) RETURNING owner_slug`,
        ]),
      );
      const deletedSkit = results[7];
      if (deletedSkit?.length !== 1) {
        const remains = yield* db(
          "check failed skit deletion",
          sql`SELECT 1 found FROM skits WHERE owner_slug = ${owner} AND skit_slug = ${slug}`,
        );
        if (remains.length !== 0) return yield* new DeleteRequiresPrivate();
        return {
          status: "absent" as const,
          skit_id: `${owner}/${slug}`,
          changed: false,
          revisions: 0,
          releases: 0,
          release_versions: [],
        };
      }
      const revisions = yield* Schema.decodeUnknownEffect(Schema.Array(RevisionRow))(
        results[3] ?? [],
      ).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode deleted revisions", cause }),
        ),
      );
      const releases = yield* Schema.decodeUnknownEffect(Schema.Array(DeletedReleaseRow))(
        results[6] ?? [],
      ).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode deleted releases", cause }),
        ),
      );
      const sortedReleases = [...releases].sort((left, right) =>
        left.published_at < right.published_at
          ? -1
          : left.published_at > right.published_at
            ? 1
            : left.release_id < right.release_id
              ? -1
              : left.release_id > right.release_id
                ? 1
                : 0,
      );
      const archiveKeys = sortedReleases.map(({ archive_object_key }) => archive_object_key);
      const deleted = yield* blobs
        .delete("delete release archives", archiveKeys)
        .pipe(Effect.result);
      if (deleted._tag === "Failure")
        yield* Effect.logError("deleted SKIT archive cleanup failed", deleted.failure);
      return {
        status: "deleted" as const,
        changed: true,
        archive_cleanup: deleted._tag === "Failure" ? ("deferred" as const) : ("complete" as const),
        skit_id: `${owner}/${slug}`,
        revisions: revisions.length,
        releases: sortedReleases.length,
        release_versions: sortedReleases.map(({ version }) => version),
      };
    });

    return SkitDeletion.of({ plan, delete: deleteSkit });
  }),
);
