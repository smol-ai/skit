import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer, Schema } from "effect";
import type { Principal } from "../auth/authentication.js";
import { Authorization, type AuthorizationService } from "../authorization/service.js";
import { DatabaseError, databaseError, type DatabaseSqlClient } from "../platform/cloudflare.js";
import type { AuthorInventoryEntry } from "./contracts.js";

const ACCESS_BATCH_SIZE = 40;
const SUBREQUEST_CONCURRENCY = 4;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const DraftRow = Schema.Struct({
  owner_slug: Schema.String,
  skit_slug: Schema.String,
  visibility: Schema.Literals(["public", "unlisted", "private"]),
  current_revision_id: Schema.String,
  most_recent_release_version: Schema.NullOr(Schema.String),
});

interface Position {
  readonly owner: string;
  readonly skit: string;
}
interface AccessBatch {
  readonly namespaces: ReadonlyArray<string>;
  readonly skits: ReadonlyArray<string>;
}
export interface AuthorInventoryQuery {
  readonly limit?: string | null;
  readonly cursor?: string | null;
}
export type AuthorInventoryPage =
  | {
      readonly outcome: "page";
      readonly skits: ReadonlyArray<AuthorInventoryEntry>;
      readonly next_cursor: string | null;
    }
  | { readonly outcome: "invalid_cursor" };

export interface AuthorInventoryService {
  readonly read: (
    principal: Principal,
    query?: AuthorInventoryQuery,
  ) => Effect.Effect<AuthorInventoryPage, DatabaseError>;
}
export class AuthorInventory extends Context.Service<AuthorInventory, AuthorInventoryService>()(
  "@skit-server-effect/AuthorInventory",
) {}

const batchesOf = <A>(values: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const batches: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < values.length; index += size)
    batches.push(values.slice(index, index + size));
  return batches;
};
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
const accessBatches = (scope: {
  readonly namespaces: ReadonlyArray<string>;
  readonly skits: ReadonlyArray<string>;
}): ReadonlyArray<AccessBatch> => [
  ...batchesOf(scope.namespaces, ACCESS_BATCH_SIZE).map((namespaces) => ({
    namespaces,
    skits: [],
  })),
  ...batchesOf(scope.skits, ACCESS_BATCH_SIZE).map((skits) => ({ namespaces: [], skits })),
];

export const layer = Layer.effect(
  AuthorInventory,
  Effect.gen(function* () {
    const sql: DatabaseSqlClient = yield* D1Client.D1Client;
    const authorization: AuthorizationService = yield* Authorization;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));

    const accessedDrafts = (batch: AccessBatch, after: Position | null, limit: number) => {
      const access = [
        batch.namespaces.length > 0
          ? `d.owner_slug IN (${batch.namespaces.map(() => "?").join(", ")})`
          : undefined,
        batch.skits.length > 0
          ? `(d.owner_slug || '/' || d.skit_slug) IN (${batch.skits.map(() => "?").join(", ")})`
          : undefined,
      ].filter((value): value is string => value !== undefined);
      return db(
        "read accessed drafts",
        sql.unsafe(
          `SELECT d.owner_slug, d.skit_slug, d.visibility, d.current_revision_id,
              (SELECT r.version FROM releases r
               WHERE r.owner_slug = d.owner_slug AND r.skit_slug = d.skit_slug
               ORDER BY r.published_at DESC, r.rowid DESC LIMIT 1) most_recent_release_version
           FROM drafts d
           WHERE d.current_revision_id IS NOT NULL
             AND (${access.join(" OR ")})
             AND (? IS NULL OR d.owner_slug > ? OR (d.owner_slug = ? AND d.skit_slug > ?))
           ORDER BY d.owner_slug, d.skit_slug LIMIT ?`,
          [
            ...batch.namespaces,
            ...batch.skits,
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
      const scope = yield* authorization.authorInventoryScope(principal);
      if (scope.namespaces.length === 0 && scope.skits.length === 0)
        return { outcome: "page" as const, skits: [], next_cursor: null };
      const rowBatches = yield* Effect.all(
        accessBatches(scope).map((batch) => accessedDrafts(batch, after, limit)),
        { concurrency: SUBREQUEST_CONCURRENCY },
      );
      const decoded = yield* Effect.forEach(rowBatches, (rows) =>
        Schema.decodeUnknownEffect(Schema.Array(DraftRow))(rows).pipe(
          Effect.mapError(
            (cause) => new DatabaseError({ operation: "decode author inventory", cause }),
          ),
        ),
      );
      const drafts = [
        ...new Map(
          decoded.flat().map((draft) => [`${draft.owner_slug}/${draft.skit_slug}`, draft] as const),
        ).values(),
      ].sort((left, right) =>
        comparePosition(
          { owner: left.owner_slug, skit: left.skit_slug },
          { owner: right.owner_slug, skit: right.skit_slug },
        ),
      );
      const page = drafts.slice(0, limit);
      const last = page.at(-1);
      return {
        outcome: "page" as const,
        skits: page.map((draft) => ({
          skit_id: `${draft.owner_slug}/${draft.skit_slug}`,
          visibility: draft.visibility,
          draft_revision_id: draft.current_revision_id,
          most_recent_release_version: draft.most_recent_release_version,
        })),
        next_cursor:
          drafts.length > limit && last
            ? formatCursor({ owner: last.owner_slug, skit: last.skit_slug })
            : null,
      };
    });
    return AuthorInventory.of({ read });
  }),
);
