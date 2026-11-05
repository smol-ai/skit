import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer, Schema } from "effect";
import type { Principal } from "../identity/service.js";
import { normalizeNamespace } from "../domain/identifiers.js";
import { DatabaseError, databaseError, type DatabaseSqlClient } from "../platform/cloudflare.js";

const SUBJECT_BATCH_SIZE = 40;
const SUBREQUEST_CONCURRENCY = 4;
const TeamMembership = Schema.Struct({ team_id: Schema.String });
const NamespaceRow = Schema.Struct({ namespace_slug: Schema.String });

interface AuthorizationSubject {
  readonly kind: "principal" | "team";
  readonly id: string;
}

export interface AuthorizationService {
  readonly ownedNamespaces: (
    principal: Principal,
  ) => Effect.Effect<ReadonlyArray<string>, DatabaseError>;
  readonly ownsNamespace: (
    principal: Principal,
    namespace: string,
  ) => Effect.Effect<boolean, DatabaseError>;
}

export class Authorization extends Context.Service<Authorization, AuthorizationService>()(
  "@skit-server-effect/Authorization",
) {}

const batches = <A>(values: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
  const output: Array<ReadonlyArray<A>> = [];
  for (let index = 0; index < values.length; index += SUBJECT_BATCH_SIZE)
    output.push(values.slice(index, index + SUBJECT_BATCH_SIZE));
  return output.length === 0 ? [[]] : output;
};

const predicate = (subjects: ReadonlyArray<AuthorizationSubject>) => ({
  sql: subjects.length
    ? subjects.map(() => "(subject_kind = ? AND subject_id = ?)").join(" OR ")
    : "0",
  bindings: subjects.flatMap((subject) => [subject.kind, subject.id]),
});

export const layer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const sql: DatabaseSqlClient = yield* D1Client.D1Client;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));

    const subjects = Effect.fn("Authorization.subjects")(function* (principal: Principal) {
      const rows = yield* db(
        "read team memberships",
        sql`SELECT team_id FROM team_memberships WHERE principal_id = ${principal.id}`,
      );
      const memberships = yield* Schema.decodeUnknownEffect(Schema.Array(TeamMembership))(
        rows,
      ).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode team memberships", cause }),
        ),
      );
      return [
        { kind: "principal" as const, id: principal.id },
        ...memberships.map(({ team_id }) => ({ kind: "team" as const, id: team_id })),
      ];
    });

    const ownsForSubjects = Effect.fn("Authorization.ownsForSubjects")(function* (
      candidates: ReadonlyArray<AuthorizationSubject>,
      namespace: string,
    ) {
      const normalized = normalizeNamespace(namespace);
      if (normalized === undefined) return false;
      const rows = yield* Effect.all(
        batches(candidates).map((batch) => {
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

    const ownsNamespace = Effect.fn("Authorization.ownsNamespace")(function* (
      principal: Principal,
      namespace: string,
    ) {
      return yield* ownsForSubjects(yield* subjects(principal), namespace);
    });

    const ownedNamespaces = Effect.fn("Authorization.ownedNamespaces")(function* (
      principal: Principal,
    ) {
      const candidates = yield* subjects(principal);
      const rows = yield* Effect.all(
        batches(candidates).map((batch) => {
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

    return Authorization.of({
      ownedNamespaces,
      ownsNamespace,
    });
  }),
);
