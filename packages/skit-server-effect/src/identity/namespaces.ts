import { D1Client } from "@effect/sql-d1";
import { Array as EffectArray, Effect, Schema } from "effect";
import type { Principal } from "./internal/credentials.js";
import { Teams } from "../teams/service.js";
import { normalizeNamespace } from "../domain/identifiers.js";
import { DatabaseError, databaseError, type DatabaseSqlClient } from "../platform/cloudflare.js";

const SUBJECT_BATCH_SIZE = 40;
const SUBREQUEST_CONCURRENCY = 4;
const NamespaceRow = Schema.Struct({ namespace_slug: Schema.String });

interface NamespaceSubject {
  readonly kind: "principal" | "team";
  readonly id: string;
}

interface NamespaceAccess {
  readonly ownedNamespaces: (
    principal: Principal,
  ) => Effect.Effect<ReadonlyArray<string>, DatabaseError>;
  readonly ownsNamespace: (
    principal: Principal,
    namespace: string,
  ) => Effect.Effect<boolean, DatabaseError>;
}

const predicate = (subjects: ReadonlyArray<NamespaceSubject>) => ({
  sql: subjects.length
    ? subjects.map(() => "(subject_kind = ? AND subject_id = ?)").join(" OR ")
    : "0",
  bindings: subjects.flatMap((subject) => [subject.kind, subject.id]),
});

export const makeNamespaceAccess = Effect.fn("Identity.makeNamespaceAccess")(function* () {
  const sql: DatabaseSqlClient = yield* D1Client.D1Client;
  const teams = yield* Teams;
  const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
    effect.pipe(databaseError(operation));

  const subjects = Effect.fn("Identity.subjects")(function* (principal: Principal) {
    const teamIds = yield* teams.memberTeamIds(principal);
    return [
      { kind: "principal" as const, id: principal.id },
      ...teamIds.map((id) => ({ kind: "team" as const, id })),
    ];
  });

  const ownsForSubjects = Effect.fn("Identity.ownsForSubjects")(function* (
    candidates: ReadonlyArray<NamespaceSubject>,
    namespace: string,
  ) {
    const normalized = normalizeNamespace(namespace);
    if (normalized === undefined) return false;
    const rows = yield* Effect.all(
      EffectArray.chunksOf(candidates, SUBJECT_BATCH_SIZE).map((batch) => {
        const where = predicate(batch);
        return db(
          "check namespace ownership",
          sql.unsafe(
            `SELECT 1 allowed FROM namespaces
             WHERE namespace_slug = ? AND (${where.sql}) LIMIT 1`,
            [normalized, ...where.bindings],
          ),
        );
      }),
      { concurrency: SUBREQUEST_CONCURRENCY },
    );
    return rows.some((row) => row.length !== 0);
  });

  const ownsNamespace = Effect.fn("Identity.ownsNamespace")(function* (
    principal: Principal,
    namespace: string,
  ) {
    return yield* ownsForSubjects(yield* subjects(principal), namespace);
  });

  const ownedNamespaces = Effect.fn("Identity.ownedNamespaces")(function* (principal: Principal) {
    const candidates = yield* subjects(principal);
    const rows = yield* Effect.all(
      EffectArray.chunksOf(candidates, SUBJECT_BATCH_SIZE).map((batch) => {
        const where = predicate(batch);
        return db(
          "list owned namespaces",
          sql.unsafe(`SELECT namespace_slug FROM namespaces WHERE ${where.sql}`, where.bindings),
        );
      }),
      { concurrency: SUBREQUEST_CONCURRENCY },
    );
    const decoded = yield* Effect.forEach(rows, (result) =>
      Schema.decodeUnknownEffect(Schema.Array(NamespaceRow))(result).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode owned namespaces", cause }),
        ),
      ),
    );
    return [...new Set(decoded.flatMap((values) => values.map((row) => row.namespace_slug)))];
  });

  return {
    ownedNamespaces,
    ownsNamespace,
  } satisfies NamespaceAccess;
});
