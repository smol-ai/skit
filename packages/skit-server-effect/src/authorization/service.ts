import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer, Schema } from "effect";
import type { Principal } from "../identity/service.js";
import { normalizeNamespace } from "../domain/identifiers.js";
import { DatabaseError, databaseError, type DatabaseSqlClient } from "../platform/cloudflare.js";

const IMPLIED_PERMISSIONS = {
  read: ["read", "change", "advance", "admin"],
  change: ["change", "advance", "admin"],
  advance: ["advance", "admin"],
  publish: ["publish", "admin"],
  admin: ["admin"],
} as const;
const SUBJECT_BATCH_SIZE = 40;
const SUBREQUEST_CONCURRENCY = 4;
const TeamMembership = Schema.Struct({ team_id: Schema.String });
const NamespaceRow = Schema.Struct({ namespace_slug: Schema.String });
const ResourceRow = Schema.Struct({ resource_id: Schema.String });

type Permission = keyof typeof IMPLIED_PERMISSIONS;
type ResourceKind = "namespace" | "skit" | "library" | "release";
interface AuthorizationSubject {
  readonly kind: "principal" | "team";
  readonly id: string;
}

export interface AuthorInventoryScope {
  readonly namespaces: ReadonlyArray<string>;
  readonly skits: ReadonlyArray<string>;
}

export interface AuthorizationService {
  readonly authorInventoryScope: (
    principal: Principal,
  ) => Effect.Effect<AuthorInventoryScope, DatabaseError>;
  readonly ownsNamespace: (
    principal: Principal,
    namespace: string,
  ) => Effect.Effect<boolean, DatabaseError>;
  readonly canAuthor: (
    principal: Principal,
    owner: string,
    slug: string,
    permission: "read" | "change" | "advance",
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

    const hasGrantForSubjects = Effect.fn("Authorization.hasGrantForSubjects")(function* (
      candidates: ReadonlyArray<AuthorizationSubject>,
      resourceKind: ResourceKind,
      resourceId: string,
      permission: Permission,
    ) {
      const allowed = IMPLIED_PERMISSIONS[permission];
      const placeholders = allowed.map(() => "?").join(", ");
      const rows = yield* Effect.all(
        batches(candidates).map((batch) => {
          const where = predicate(batch);
          return db(
            "check resource grant",
            sql.unsafe(
              `SELECT 1 allowed FROM resource_grants
               WHERE (${where.sql}) AND resource_kind = ? AND resource_id = ?
                 AND permission IN (${placeholders}) LIMIT 1`,
              [...where.bindings, resourceKind, resourceId, ...allowed],
            ),
          );
        }),
        { concurrency: SUBREQUEST_CONCURRENCY },
      );
      return rows.some((row) => row.length !== 0);
    });

    const canAuthor = Effect.fn("Authorization.canAuthor")(function* (
      principal: Principal,
      owner: string,
      slug: string,
      permission: "read" | "change" | "advance",
    ) {
      const candidates = yield* subjects(principal);
      if (yield* ownsForSubjects(candidates, owner)) return true;
      return yield* hasGrantForSubjects(candidates, "skit", `${owner}/${slug}`, permission);
    });

    const authorInventoryScope = Effect.fn("Authorization.authorInventoryScope")(function* (
      principal: Principal,
    ) {
      const candidates = yield* subjects(principal);
      const allowed = IMPLIED_PERMISSIONS.read;
      const placeholders = allowed.map(() => "?").join(", ");
      const rows = yield* Effect.all(
        batches(candidates).map((batch) => {
          const where = predicate(batch);
          return Effect.all([
            db(
              "list owned namespaces",
              sql.unsafe(
                `SELECT namespace_slug FROM namespaces WHERE ${where.sql}`,
                where.bindings,
              ),
            ),
            db(
              "list granted skits",
              sql.unsafe(
                `SELECT resource_id FROM resource_grants
                 WHERE resource_kind = 'skit' AND permission IN (${placeholders})
                   AND (${where.sql})`,
                [...allowed, ...where.bindings],
              ),
            ),
          ]);
        }),
        { concurrency: SUBREQUEST_CONCURRENCY },
      );
      const decoded = yield* Effect.forEach(rows, ([namespaceRows, skitRows]) =>
        Effect.all([
          Schema.decodeUnknownEffect(Schema.Array(NamespaceRow))(namespaceRows),
          Schema.decodeUnknownEffect(Schema.Array(ResourceRow))(skitRows),
        ]).pipe(
          Effect.mapError(
            (cause) => new DatabaseError({ operation: "decode author scope", cause }),
          ),
        ),
      );
      return {
        namespaces: [
          ...new Set(decoded.flatMap(([values]) => values.map((row) => row.namespace_slug))),
        ],
        skits: [...new Set(decoded.flatMap(([, values]) => values.map((row) => row.resource_id)))],
      };
    });

    return Authorization.of({
      authorInventoryScope,
      ownsNamespace,
      canAuthor,
    });
  }),
);
