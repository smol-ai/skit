import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeWebHandler } from "../src/http.js";

const host = <A>(evaluate: () => Promise<A>) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- Worker Fetch, D1 and Web Crypto are Promise-only test-host APIs.
  Effect.promise(evaluate);

const web = makeWebHandler(env);

it.effect("keeps typed decoding before scope refusal and raw publication decoding after it", () =>
  Effect.gen(function* () {
    yield* host(() => reset());
    yield* host(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
    yield* host(() =>
      env.DB.batch([
        env.DB.prepare(
          `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
           VALUES ('scope_user', 'Scope fixture', 'scope@example.test', 1, 1, 1)`,
        ),
        env.DB.prepare(
          `INSERT INTO principals (principal_id, better_auth_user_id, state, authorization_generation, created_at, updated_at)
           VALUES ('scope_principal', 'scope_user', 'active', 1, 'created', 'updated')`,
        ),
      ]),
    );
    for (const scope of ["library:sync", "publication:write"]) {
      const token = `skit_pat_scope_${scope}`;
      const digest = yield* host(() =>
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      );
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      yield* host(() =>
        env.DB.prepare(
          `INSERT INTO personal_access_tokens (token_id, principal_id, token_hash, token_prefix, name, scopes_json, authorization_generation, created_at)
           VALUES (?, 'scope_principal', ?, 'fixture', 'fixture', ?, 1, 'created')`,
        )
          .bind(scope, hash, JSON.stringify([scope]))
          .run(),
      );
    }
    const request = (path: string, method: string, scope: string, body?: string) =>
      host(() =>
        web.handler(
          new Request(`https://registry.test${path}`, {
            method,
            headers: {
              authorization: `Bearer skit_pat_scope_${scope}`,
              "content-type": "application/json",
            },
            body,
          }),
        ),
      );
    for (const [path, method] of [
      ["/api/library/portable", "PUT"],
      ["/api/library/snapshots", "POST"],
      ["/api/skits", "POST"],
    ]) {
      const response = yield* request(path, method, "publication:write", "{}");
      expect(response.status, path).toBe(400);
      expect(yield* host(() => response.json())).toEqual({ error: "invalid_request" });
    }
    for (const [path, method, scope, body] of [
      ["/api/library/portable", "GET", "publication:write"],
      [`/api/libraries/fixture/snapshots/sha256:${"a".repeat(64)}`, "GET", "publication:write"],
      ["/api/author/skits", "GET", "publication:write"],
      ["/api/skits/alice/tools/current", "GET", "publication:write"],
      ["/api/skits/alice/tools", "DELETE", "publication:write"],
      ["/api/skits/alice/tools/releases", "POST", "library:sync", "malformed JSON"],
    ]) {
      const response = yield* request(path, method, scope, body);
      expect(response.status, path).toBe(403);
      expect(yield* host(() => response.json())).toEqual({ error: "insufficient_scope" });
    }
    for (const table of ["skits", "revisions", "releases", "libraries", "library_snapshots"]) {
      const rows = yield* host(() => env.DB.prepare(`SELECT * FROM ${table}`).all());
      expect(rows.results, table).toEqual([]);
    }
  }),
);
