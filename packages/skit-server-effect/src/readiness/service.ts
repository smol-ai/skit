import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer, Schema } from "effect";
import type { Principal } from "../auth/authentication.js";
import {
  Bindings,
  DatabaseError,
  blobStorageEffectFrom,
  databaseError,
  type CloudflareBindings,
  type DatabaseSqlClient,
  type RuntimeEnv,
} from "../platform/cloudflare.js";
import { Readiness, type ReadinessCheck } from "./contracts.js";
import { expectedMigrations } from "./migrations.generated.js";
export { Readiness, ReadinessCheck } from "./contracts.js";

const MigrationRow = Schema.Struct({ name: Schema.String });

export interface ReadinessService {
  readonly isServerOperator: (principal: Principal) => Effect.Effect<boolean, DatabaseError>;
  readonly inspect: (requestOrigin: string) => Effect.Effect<Readiness>;
}

export class ReadinessInspector extends Context.Service<ReadinessInspector, ReadinessService>()(
  "@skit-server-effect/ReadinessInspector",
) {}

export const layer = (env: RuntimeEnv) =>
  Layer.effect(
    ReadinessInspector,
    Effect.gen(function* () {
      const bindings: CloudflareBindings = yield* Bindings;
      const sql: DatabaseSqlClient = yield* D1Client.D1Client;
      const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
        effect.pipe(databaseError(operation));
      const blob = <A>(operation: string, run: (bucket: R2Bucket) => Promise<A>) =>
        blobStorageEffectFrom(bindings.blobs, operation, run);

      const isServerOperator = Effect.fn("Readiness.isServerOperator")(function* (
        principal: Principal,
      ) {
        const rows = yield* db(
          "check server operator",
          sql<{ readonly authorized: number }>`
        SELECT 1 authorized FROM server_operators WHERE principal_id = ${principal.id}
      `,
        );
        return rows.length > 0;
      });

      const inspect = Effect.fn("Readiness.inspect")(function* (requestOrigin: string) {
        const missing = [
          !env.PUBLIC_APP_ORIGIN && "PUBLIC_APP_ORIGIN",
          !env.BETTER_AUTH_SECRET && "BETTER_AUTH_SECRET",
          !env.AUTH_RATE_LIMITER && "AUTH_RATE_LIMITER",
          !env.PAT_RATE_LIMITER && "PAT_RATE_LIMITER",
          !env.BOOTSTRAP_RATE_LIMITER && "BOOTSTRAP_RATE_LIMITER",
        ].filter((value): value is string => Boolean(value));
        const configuration: ReadinessCheck = {
          name: "configuration",
          status: missing.length > 0 ? "error" : "ok",
          detail:
            missing.length > 0
              ? `Missing ${missing.join(", ")}`
              : "Required bindings are configured",
        };

        const configuredOrigin = env.PUBLIC_APP_ORIGIN
          ? URL.parse(env.PUBLIC_APP_ORIGIN)?.origin
          : undefined;
        const origin: ReadinessCheck = {
          name: "origin",
          status: configuredOrigin === requestOrigin ? "ok" : "error",
          detail:
            configuredOrigin === requestOrigin
              ? `Serving configured origin ${requestOrigin}`
              : `Request origin ${requestOrigin} does not match configured origin`,
        };
        const email: ReadinessCheck = {
          name: "email",
          status: "ok",
          detail:
            env.EMAIL && env.EMAIL_FROM
              ? `Email Service binding configured for ${env.EMAIL_FROM}; delivery is not probed`
              : "Email verification is disabled",
        };

        const [d1, migrations, r2, bootstrap] = yield* Effect.all(
          [
            db("read readiness sentinel", sql`SELECT 1 ready`).pipe(
              Effect.result,
              Effect.map((result): ReadinessCheck => ({
                name: "d1",
                status: result._tag === "Success" ? "ok" : "error",
                detail: result._tag === "Success" ? "D1 is reachable" : "D1 query failed",
              })),
            ),
            db("read migration history", sql`SELECT name FROM d1_migrations ORDER BY name`).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MigrationRow))),
              Effect.result,
              Effect.map((result): ReadinessCheck => {
                if (result._tag === "Failure")
                  return {
                    name: "migrations",
                    status: "error",
                    detail: "Unable to read D1 migration history",
                  };
                const applied = result.success.map(({ name }) => name);
                const current =
                  applied.length === expectedMigrations.length &&
                  expectedMigrations.every((migration, index) => migration === applied[index]);
                return {
                  name: "migrations",
                  status: current ? "ok" : "error",
                  detail: current
                    ? `Applied ${applied.length} expected migrations`
                    : `Expected ${expectedMigrations.join(", ")}; found ${applied.join(", ") || "none"}`,
                };
              }),
            ),
            blob("list readiness sentinel", (bucket) => bucket.list({ limit: 1 })).pipe(
              Effect.result,
              Effect.map((result): ReadinessCheck => ({
                name: "r2",
                status: result._tag === "Success" ? "ok" : "error",
                detail: result._tag === "Success" ? "R2 is reachable" : "R2 list failed",
              })),
            ),
            db(
              "read readiness bootstrap",
              sql<{ readonly claimed: number }>`
            SELECT 1 claimed FROM server_bootstrap WHERE id = 'singleton'
          `,
            ).pipe(
              Effect.result,
              Effect.map((result): ReadinessCheck =>
                result._tag === "Failure"
                  ? {
                      name: "bootstrap",
                      status: "error",
                      detail: "Unable to read bootstrap state",
                    }
                  : result.success.length === 0
                    ? {
                        name: "bootstrap",
                        status: "error",
                        detail: "Initial operator bootstrap is incomplete",
                      }
                    : { name: "bootstrap", status: "ok", detail: "Initial operator exists" },
              ),
            ),
          ],
          { concurrency: 4 },
        );
        const checks = [configuration, origin, email, d1, migrations, r2, bootstrap];
        return { ready: checks.every(({ status }) => status === "ok"), checks };
      });

      return ReadinessInspector.of({ isServerOperator, inspect });
    }),
  );
