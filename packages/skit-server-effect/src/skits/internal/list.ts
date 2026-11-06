import { Array as EffectArray, Effect, Schema } from "effect";
import type { Principal } from "../../identity/service.js";
import { DatabaseError, databaseError, type DatabaseSqlClient } from "../../platform/cloudflare.js";
import type { AuthorSkitSummary } from "@smolai/skit-core/universal/api";
import * as History from "@smolai/skit-core/history";

const ACCESS_BATCH_SIZE = 40;
const SUBREQUEST_CONCURRENCY = 4;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const SkitRow = Schema.Struct({
  owner_slug: Schema.String,
  skit_slug: Schema.String,
  visibility: Schema.Literals(["public", "unlisted", "private"]),
  current_revision_id: History.RevisionId,
  current_revision_published: Schema.Literals([0, 1]),
  most_recent_release_version: Schema.NullOr(Schema.String),
});

interface Position {
  readonly owner: string;
  readonly skit: string;
}
interface AuthorInventoryQuery {
  readonly limit?: string | null;
  readonly cursor?: string | null;
}
type AuthorInventoryPage =
  | {
      readonly outcome: "page";
      readonly skits: ReadonlyArray<AuthorSkitSummary>;
      readonly next_cursor: string | null;
    }
  | { readonly outcome: "invalid_cursor" };

export type List = (
  principal: Principal,
  query?: AuthorInventoryQuery,
) => Effect.Effect<AuthorInventoryPage, DatabaseError>;

const compareAscii = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const comparePosition = (left: Position, right: Position) =>
  compareAscii(left.owner, right.owner) || compareAscii(left.skit, right.skit);
const parseCursor = (value: string | null | undefined): Position | null | undefined => {
  if (value === null || value === undefined) return null;
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) return undefined;
  return { owner: value.slice(0, separator), skit: value.slice(separator + 1) };
};
const formatCursor = (position: Position) => `${position.owner}/${position.skit}`;
const parseLimit = (value: string | null | undefined) => {
  const requested = Number(value || String(DEFAULT_LIMIT));
  if (!Number.isInteger(requested)) return DEFAULT_LIMIT;
  return Math.min(Math.max(requested, 1), MAX_LIMIT);
};
/** Skits owns inventory filtering; access is limited to the caller's owned namespaces. */
export const makeList = (
  sql: DatabaseSqlClient,
  ownedNamespaces: (principal: Principal) => Effect.Effect<ReadonlyArray<string>, DatabaseError>,
): List => {
  const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(databaseError(operation));

  const accessedSkits = (
    namespaces: ReadonlyArray<string>,
    after: Position | null,
    limit: number,
  ) => {
    return db(
      "read accessed skits",
      sql.unsafe(
        `SELECT d.owner_slug, d.skit_slug, d.visibility, d.current_revision_id,
            EXISTS (SELECT 1 FROM releases published
              WHERE published.owner_slug = d.owner_slug AND published.skit_slug = d.skit_slug
                AND published.source_revision = d.current_revision_id) current_revision_published,
            (SELECT r.version FROM releases r
             WHERE r.owner_slug = d.owner_slug AND r.skit_slug = d.skit_slug
             ORDER BY r.published_at DESC, r.rowid DESC LIMIT 1) most_recent_release_version
         FROM skits d
         WHERE d.current_revision_id IS NOT NULL
           AND d.owner_slug IN (${namespaces.map(() => "?").join(", ")})
           AND (? IS NULL OR d.owner_slug > ? OR (d.owner_slug = ? AND d.skit_slug > ?))
         ORDER BY d.owner_slug, d.skit_slug LIMIT ?`,
        [
          ...namespaces,
          after === null ? null : formatCursor(after),
          after?.owner ?? null,
          after?.owner ?? null,
          after?.skit ?? null,
          limit + 1,
        ],
      ),
    );
  };

  const read = Effect.fn("AuthorInventory.read")(function* (
    principal: Principal,
    query: AuthorInventoryQuery = {},
  ) {
    const after = parseCursor(query.cursor);
    if (after === undefined) return { outcome: "invalid_cursor" as const };
    const limit = parseLimit(query.limit);
    const namespaces = yield* ownedNamespaces(principal);
    if (namespaces.length === 0) return { outcome: "page" as const, skits: [], next_cursor: null };
    const rowBatches = yield* Effect.all(
      EffectArray.chunksOf(namespaces, ACCESS_BATCH_SIZE).map((batch) =>
        accessedSkits(batch, after, limit),
      ),
      { concurrency: SUBREQUEST_CONCURRENCY },
    );
    const decoded = yield* Effect.forEach(rowBatches, (rows) =>
      Schema.decodeUnknownEffect(Schema.Array(SkitRow))(rows).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode author inventory", cause }),
        ),
      ),
    );
    const skits = [
      ...new Map(
        decoded.flat().map((skit) => [`${skit.owner_slug}/${skit.skit_slug}`, skit] as const),
      ).values(),
    ].sort((left, right) =>
      comparePosition(
        { owner: left.owner_slug, skit: left.skit_slug },
        { owner: right.owner_slug, skit: right.skit_slug },
      ),
    );
    const page = skits.slice(0, limit);
    const last = page.at(-1);
    return {
      outcome: "page" as const,
      skits: page.map((skit) => ({
        skit_id: `${skit.owner_slug}/${skit.skit_slug}`,
        visibility: skit.visibility,
        current_revision_id: skit.current_revision_id,
        current_revision_published: skit.current_revision_published === 1,
        most_recent_release_version: skit.most_recent_release_version,
      })),
      next_cursor:
        skits.length > limit && last
          ? formatCursor({ owner: last.owner_slug, skit: last.skit_slug })
          : null,
    };
  });
  return read;
};
