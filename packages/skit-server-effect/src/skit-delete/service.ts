import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer, Schema } from "effect";
import {
  Bindings,
  DatabaseError,
  blobStorageEffectFrom,
  databaseError,
  type CloudflareBindings,
  type DatabaseSqlClient,
} from "../platform/cloudflare.js";
import { SkitDeleteResult } from "./contracts.js";
export { SkitDeleteResult } from "./contracts.js";

const DraftVisibility = Schema.Struct({
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
  readonly draft_revisions: number;
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
  ) => Effect.Effect<SkitDeleteResult, DatabaseError | DeleteRequiresPrivate>;
}
export class SkitDeletion extends Context.Service<SkitDeletion, SkitDeletionService>()(
  "@skit-server-effect/SkitDeletion",
) {}

export const layer = Layer.effect(
  SkitDeletion,
  Effect.gen(function* () {
    const bindings: CloudflareBindings = yield* Bindings;
    const sql: DatabaseSqlClient = yield* D1Client.D1Client;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));
    const blob = <A>(operation: string, run: (bucket: R2Bucket) => Promise<A>) =>
      blobStorageEffectFrom(bindings.blobs, operation, run);

    const plan = Effect.fn("SkitDeletion.plan")(function* (owner: string, slug: string) {
      const draftRows = yield* db(
        "find draft for deletion",
        sql`SELECT visibility FROM drafts WHERE owner_slug = ${owner} AND skit_slug = ${slug}`,
      );
      if (draftRows[0] === undefined) return undefined;
      const draft = yield* Schema.decodeUnknownEffect(DraftVisibility)(draftRows[0]).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode deletion draft", cause }),
        ),
      );
      const [revisionRows, releaseRows] = yield* Effect.all([
        db(
          "list draft revisions for deletion",
          sql`SELECT revision_id FROM draft_revisions
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
        draft.visibility !== "private" ||
        releases.some(({ visibility }) => visibility !== "private")
      )
        return yield* new DeleteRequiresPrivate();
      return {
        skit_id: `${owner}/${slug}`,
        draft_revisions: revisions.length,
        releases: releases.length,
        release_versions: releases.map(({ version }) => version),
      };
    });

    const deleteSkit = Effect.fn("SkitDeletion.delete")(function* (owner: string, slug: string) {
      const guard = `EXISTS (
      SELECT 1 FROM drafts
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
            `DELETE FROM draft_files WHERE revision_id IN
             (SELECT revision_id FROM draft_revisions WHERE owner_slug = ? AND skit_slug = ?)
             AND ${guard}`,
            [owner, slug, ...guardBindings],
          ),
          sql.unsafe(
            `DELETE FROM draft_revisions WHERE owner_slug = ? AND skit_slug = ?
             AND ${guard} RETURNING revision_id`,
            [owner, slug, ...guardBindings],
          ),
          sql.unsafe(
            `DELETE FROM releases WHERE owner_slug = ? AND skit_slug = ?
             AND ${guard} RETURNING release_id, version, archive_object_key, published_at`,
            [owner, slug, ...guardBindings],
          ),
          sql`DELETE FROM drafts WHERE owner_slug = ${owner} AND skit_slug = ${slug} AND visibility = 'private'
             AND NOT EXISTS (
               SELECT 1 FROM releases WHERE owner_slug = ${owner} AND skit_slug = ${slug}
             ) RETURNING owner_slug`,
        ]),
      );
      const deletedDraft = results[5];
      if (deletedDraft?.length !== 1) {
        const remains = yield* db(
          "check failed skit deletion",
          sql`SELECT 1 found FROM drafts WHERE owner_slug = ${owner} AND skit_slug = ${slug}`,
        );
        if (remains.length !== 0) return yield* new DeleteRequiresPrivate();
        return {
          status: "absent" as const,
          skit_id: `${owner}/${slug}`,
          changed: false,
          draft_revisions: 0,
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
        results[4] ?? [],
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
      let archiveCleanup: "complete" | "deferred" = "complete";
      for (let index = 0; index < archiveKeys.length; index += 1_000) {
        const deleted = yield* blob("delete release archives", (bucket) =>
          bucket.delete(archiveKeys.slice(index, index + 1_000)),
        ).pipe(Effect.result);
        if (deleted._tag === "Failure") {
          archiveCleanup = "deferred";
          yield* Effect.logError("deleted SKIT archive cleanup failed", deleted.failure);
          break;
        }
      }
      return {
        status: "deleted" as const,
        changed: true,
        archive_cleanup: archiveCleanup,
        skit_id: `${owner}/${slug}`,
        draft_revisions: revisions.length,
        releases: sortedReleases.length,
        release_versions: sortedReleases.map(({ version }) => version),
      };
    });

    return SkitDeletion.of({ plan, delete: deleteSkit });
  }),
);
