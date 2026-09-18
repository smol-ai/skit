import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { skitLayer } from "@smolai/skit-core";
import {
  addRegistryRemoteEffect,
  authStatusCommand,
  loginEffect,
  logoutEffect,
  resolveAuthEffect,
  resolveAuthForOriginEffect,
  resolveLoginTargetEffect,
} from "../src/registry/auth.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { testHttpClientLayer, type TestHttpHandler } from "./helpers/http-test-client.js";

/**
 * The native login with an injected Registry transport.
 *
 * `loginEffect` owns its requests through `RegistryHttp`, so a test supplies a transport by
 * providing that layer. One Scope per login, as the command has.
 */
const login = (
  input: { origin: string; email: string; password: string; scopes: string[]; home?: string },
  handler: TestHttpHandler,
) =>
  Effect.scoped(
    loginEffect(input as Parameters<typeof loginEffect>[0]).pipe(
      Effect.provide(registryHttpLayer(testHttpClientLayer(handler))),
    ),
  );

const logout = (handler: TestHttpHandler, home: string, selectedOrigin?: string) =>
  Effect.scoped(
    logoutEffect(home, selectedOrigin).pipe(
      Effect.provide(registryHttpLayer(testHttpClientLayer(handler))),
    ),
  );

const authHome = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "skit-auth-" }),
);
const readText = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path));

const originalServer = process.env.SKIT_SERVER_URL;
const originalToken = process.env.SKIT_TOKEN;
afterEach(() => {
  if (originalServer === undefined) delete process.env.SKIT_SERVER_URL;
  else process.env.SKIT_SERVER_URL = originalServer;
  if (originalToken === undefined) delete process.env.SKIT_TOKEN;
  else process.env.SKIT_TOKEN = originalToken;
});

/**
 * The request payload, however the transport chose to carry it.
 *
 * Effect's HTTP client sends an encoded body rather than the string handed to it, which is an
 * incidental transport detail; what these tests protect is the payload, not its representation.
 */
function payload(init?: RequestInit): string {
  const body = init?.body;
  if (body === undefined || body === null) return "";
  return typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array);
}

function requestInit(request: Parameters<TestHttpHandler>[0]): RequestInit {
  return {
    method: request.method,
    headers: request.headers,
    body:
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined,
  };
}

const MintRequest = Schema.Struct({
  scopes: Schema.Array(Schema.String),
  expires_at: Schema.String,
});
const MintedToken = Schema.Struct({
  token: Schema.String,
  token_id: Schema.String,
  token_prefix: Schema.String,
  scopes: Schema.Array(Schema.String),
  expires_at: Schema.optional(Schema.String),
});

function successfulServer(observed: Array<{ url: string; init?: RequestInit }>): TestHttpHandler {
  let minted = 0;
  return async (request) => {
    const url = request.url;
    const init = requestInit(request);
    observed.push({ url, init });
    if (url.endsWith("/.well-known/skit"))
      return Response.json({
        schema: "skit.server.v1",
        download: "/api/skits/{owner}/{slug}/releases/{version}/download",
        scopes: ["library:sync", "authoring:write", "publication:write"],
      });
    if (url.endsWith("/api/auth/sign-in/email"))
      return new Response("{}", {
        status: 200,
        headers: { "set-cookie": "skit-auth.session_token=session-secret; Path=/; HttpOnly" },
      });
    if (url.endsWith("/api/tokens") && init?.method === "POST") {
      const suffix = minted++ === 0 ? "one" : "two";
      const requested = Schema.decodeUnknownSync(MintRequest)(JSON.parse(payload(init)));
      return Response.json(
        {
          token: `skit_pat_secret_${suffix}`,
          token_id: `pat_${suffix}`,
          token_prefix: `skit_pat_secret_${suffix}`.slice(0, 18),
          scopes: requested.scopes,
          expires_at: requested.expires_at,
        },
        { status: 201 },
      );
    }
    if (url.endsWith("/api/auth/sign-out")) return Response.json({ success: true });
    if (url.includes("/api/tokens/pat_") && init?.method === "DELETE")
      return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  };
}

describe("CLI authentication journey", () => {
  it.effect("requires an explicit Registry when no default is configured", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      expect(yield* Effect.flip(resolveLoginTargetEffect(undefined, home))).toMatchObject({
        _tag: "DefaultRegistryNotConfigured",
      });
      expect(yield* Effect.flip(resolveLoginTargetEffect("missing", home))).toMatchObject({
        _tag: "RegistryAliasNotFound",
        name: "missing",
      });
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("rejects scopes the selected Registry does not advertise before sign-in", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const observed: string[] = [];
      const exit = yield* Effect.exit(
        login(
          {
            origin: "https://skit.example",
            email: "user@example.test",
            password: "secret",
            scopes: ["authoring:write"],
            home,
          },
          async (request) => {
            observed.push(new URL(request.url).pathname);
            return Response.json({
              schema: "skit.server.v1",
              download: "/api/skits/{owner}/{slug}/releases/{version}/download",
              scopes: ["library:sync"],
            });
          },
        ),
      );

      expect(observed).toEqual(["/.well-known/skit"]);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(String(exit.cause)).toContain("authoring:write");
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect(
    "exchanges a password session for a stored expiring PAT and signs the session out",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* authHome;
        const observed: Array<{ url: string; init?: RequestInit }> = [];
        yield* login(
          {
            origin: "https://skit.example",
            email: "user@example.test",
            password: "not-stored",
            scopes: ["library:sync"],
            home,
          },
          successfulServer(observed),
        );

        expect(observed.map(({ url }) => new URL(url).pathname)).toEqual([
          "/.well-known/skit",
          "/api/auth/sign-in/email",
          "/api/tokens",
          "/api/auth/sign-out",
        ]);
        const mint = observed[2].init!;
        expect(new Headers(mint.headers).get("origin")).toBe("https://skit.example");
        expect(new Headers(mint.headers).get("cookie")).toContain("skit-auth.session_token=");
        expect(payload(mint)).not.toContain("not-stored");
        const path = join(home, "auth.json");
        expect((yield* fs.stat(path)).mode & 0o777).toBe(0o600);
        expect(yield* readText(path)).not.toContain("not-stored");
        const storedConfig = JSON.parse(yield* readText(path));
        expect(storedConfig).not.toHaveProperty("activeOrigin");
        expect(storedConfig).toMatchObject({
          defaultRegistry: "default",
          registryAliases: { default: "https://skit.example" },
        });
        expect(yield* resolveAuthEffect(home)).toMatchObject({
          origin: "https://skit.example",
          token: "skit_pat_secret_one",
          tokenId: "pat_one",
          scopes: ["library:sync"],
          source: "stored",
        });
        expect(yield* resolveLoginTargetEffect(undefined, home)).toBe("https://skit.example");
        expect(yield* resolveLoginTargetEffect("default", home)).toBe("https://skit.example");
      }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("reports an unknown expiry honestly when an older server omits it", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      const base = successfulServer(observed);
      const server: TestHttpHandler = async (request) => {
        const response = await base(request);
        if (request.url.endsWith("/api/tokens") && request.method === "POST") {
          const { expires_at: _omitted, ...body } = Schema.decodeUnknownSync(MintedToken)(
            await response.json(),
          );
          return Response.json(body, { status: 201 });
        }
        return response;
      };

      const result = yield* login(
        {
          origin: "https://skit.example",
          email: "user@example.test",
          password: "secret",
          scopes: ["library:sync"],
          home,
        },
        server,
      );

      expect(result).not.toHaveProperty("expiresAt");
      expect(yield* resolveAuthEffect(home)).toMatchObject({
        source: "stored",
        expiresAt: undefined,
      });
      expect(yield* readText(join(home, "auth.json"))).not.toContain("expiresAt");
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("a second login preserves the first configured default", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      const server = successfulServer(observed);
      for (const origin of ["https://one.example", "https://two.example"])
        yield* login(
          {
            origin,
            email: "user@example.test",
            password: "secret",
            scopes: ["authoring:write"],
            home,
          },
          server,
        );

      expect(yield* resolveAuthEffect(home)).toMatchObject({
        origin: "https://one.example",
        token: "skit_pat_secret_one",
      });
      expect(yield* resolveAuthForOriginEffect("https://one.example", home)).toMatchObject({
        origin: "https://one.example",
        token: "skit_pat_secret_one",
        source: "stored",
      });
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("revokes the active PAT before removing it locally", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      const server = successfulServer(observed);
      yield* login(
        {
          origin: "https://skit.example",
          email: "user@example.test",
          password: "secret",
          scopes: ["library:sync"],
          home,
        },
        server,
      );
      observed.length = 0;

      expect(yield* logout(server, home)).toEqual({
        origin: "https://skit.example",
        revoked: true,
      });
      expect(observed).toHaveLength(1);
      expect(new Headers(observed[0].init?.headers).get("authorization")).toBe(
        "Bearer skit_pat_secret_one",
      );
      expect(yield* resolveAuthEffect(home)).toMatchObject({ source: "none", token: undefined });
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("revokes a minted PAT when temporary-session sign-out fails", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      const base = successfulServer(observed);
      const server: TestHttpHandler = async (request) => {
        if (request.url.endsWith("/api/auth/sign-out")) {
          observed.push({ url: request.url, init: requestInit(request) });
          return new Response(null, { status: 503 });
        }
        return base(request);
      };

      const failure = yield* Effect.flip(
        login(
          {
            origin: "https://skit.example",
            email: "user@example.test",
            password: "secret",
            scopes: ["library:sync"],
            home,
          },
          server,
        ),
      );
      expect(failure.message).toContain("Sign out failed");
      expect(observed.map(({ url }) => new URL(url).pathname)).toContain("/api/tokens/pat_one");
      expect(yield* resolveAuthEffect(home)).toMatchObject({ source: "none" });
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("reports when both temporary-session cleanup operations fail", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      const base = successfulServer(observed);
      const server: TestHttpHandler = async (request) => {
        const url = request.url;
        if (url.endsWith("/api/auth/sign-out") || url.includes("/api/tokens/pat_"))
          return new Response(null, { status: 503 });
        return base(request);
      };

      const failure = yield* Effect.flip(
        login(
          {
            origin: "https://skit.example",
            email: "user@example.test",
            password: "secret",
            scopes: ["library:sync"],
            home,
          },
          server,
        ),
      );
      expect(failure.message).toMatch(/pat_one.*skit_pat_secret.*session may also be live/);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("logging in again rotates the credential for that origin", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      const server = successfulServer(observed);
      const credentials = (scopes: Array<"library:sync" | "authoring:write">) => ({
        origin: "https://skit.example",
        email: "user@example.test",
        password: "secret",
        scopes,
        home,
      });
      yield* login(credentials(["library:sync"]), server);
      yield* login(credentials(["library:sync", "authoring:write"]), server);

      expect(yield* resolveAuthEffect(home)).toMatchObject({
        tokenId: "pat_two",
        token: "skit_pat_secret_two",
        scopes: ["library:sync", "authoring:write"],
      });
      expect(observed.map(({ url }) => new URL(url).pathname)).toContain("/api/tokens/pat_one");
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("keeps the previous stored credential working when replacement cannot be saved", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* authHome;
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      const server = successfulServer(observed);
      const input = {
        origin: "https://skit.example",
        email: "user@example.test",
        password: "secret",
        scopes: ["library:sync"] as const,
        home,
      };
      yield* login({ ...input, scopes: [...input.scopes] }, server);
      observed.length = 0;
      yield* fs.chmod(home, 0o500);
      const exit = yield* Effect.exit(login({ ...input, scopes: [...input.scopes] }, server)).pipe(
        Effect.ensuring(fs.chmod(home, 0o700).pipe(Effect.orDie)),
      );
      expect(exit._tag).toBe("Failure");

      expect(yield* resolveAuthEffect(home)).toMatchObject({ tokenId: "pat_one" });
      const revoked = observed
        .filter(({ init }) => init?.method === "DELETE")
        .map(({ url }) => new URL(url).pathname);
      expect(revoked).toEqual(["/api/tokens/pat_two"]);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("keeps the new credential and warns when the previous token cannot be revoked", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      const base = successfulServer(observed);
      const server: TestHttpHandler = async (request) => {
        if (request.url.endsWith("/api/tokens/pat_one") && request.method === "DELETE") {
          observed.push({ url: request.url, init: requestInit(request) });
          return new Response(null, { status: 503 });
        }
        return base(request);
      };
      const input = {
        origin: "https://skit.example",
        email: "user@example.test",
        password: "secret",
        scopes: ["library:sync"] as const,
        home,
      };
      yield* login({ ...input, scopes: [...input.scopes] }, server);
      const result = yield* login({ ...input, scopes: [...input.scopes] }, server);

      expect(result.warning).toMatch(/pat_one.*may still be live/);
      expect(yield* resolveAuthEffect(home)).toMatchObject({ tokenId: "pat_two" });
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("logout preserves a default even when its credential is removed", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      const server = successfulServer(observed);
      yield* login(
        {
          origin: "https://one.example",
          email: "user@example.test",
          password: "secret",
          scopes: ["library:sync"],
          home,
        },
        server,
      );
      yield* login(
        {
          origin: "https://two.example",
          email: "user@example.test",
          password: "secret",
          scopes: ["library:sync"],
          home,
        },
        server,
      );

      yield* logout(server, home, "https://one.example");
      expect(yield* resolveAuthEffect(home)).toMatchObject({
        origin: "https://one.example",
        token: undefined,
      });
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("environment origin and token override stored authentication", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      yield* login(
        {
          origin: "https://stored.example",
          email: "user@example.test",
          password: "secret",
          scopes: ["library:sync"],
          home,
        },
        successfulServer(observed),
      );
      process.env.SKIT_SERVER_URL = "https://environment.example/path";
      process.env.SKIT_TOKEN = "skit_pat_environment";
      expect(yield* resolveAuthEffect(home)).toMatchObject({
        origin: "https://environment.example",
        token: "skit_pat_environment",
        source: "environment",
      });
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("legacy activeOrigin is ignored and removed on the next write", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* authHome;
      const credential = (suffix: string) => ({
        token: `secret-${suffix}`,
        tokenId: suffix,
        tokenPrefix: `secret-${suffix}`,
        scopes: ["library:sync"],
      });
      yield* fs.writeFileString(
        join(home, "auth.json"),
        JSON.stringify({
          schemaVersion: 1,
          activeOrigin: "https://two.example",
          servers: {
            "https://one.example": credential("one"),
            "https://two.example": credential("two"),
          },
        }),
      );

      expect(yield* Effect.flip(resolveAuthEffect(home))).toMatchObject({
        _tag: "RegistrySelectionAmbiguous",
        origins: ["https://one.example", "https://two.example"],
      });
      yield* addRegistryRemoteEffect("one", "https://one.example", home);
      const stored = JSON.parse(yield* fs.readFileString(join(home, "auth.json")));
      expect(stored).not.toHaveProperty("activeOrigin");
      expect(stored).not.toHaveProperty("defaultRegistry");
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("logout without a target refuses multiple credentials", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      const server = successfulServer(observed);
      for (const origin of ["https://one.example", "https://two.example"])
        yield* login(
          {
            origin,
            email: "user@example.test",
            password: "secret",
            scopes: ["library:sync"],
            home,
          },
          server,
        );
      observed.length = 0;

      expect(yield* Effect.flip(logout(server, home))).toMatchObject({
        _tag: "RegistrySelectionAmbiguous",
        origins: ["https://one.example", "https://two.example"],
      });
      expect(observed).toEqual([]);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("status lists environment credentials as a distinct row", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      yield* login(
        {
          origin: "https://stored.example",
          email: "user@example.test",
          password: "secret",
          scopes: ["library:sync"],
          home,
        },
        successfulServer(observed),
      );
      process.env.SKIT_SERVER_URL = "https://environment.example/path";
      process.env.SKIT_TOKEN = "skit_pat_environment";

      const status = yield* authStatusCommand(home);
      expect(status.credentials).toMatchObject([
        { origin: "https://stored.example", source: "stored" },
        { origin: "https://environment.example", source: "environment" },
      ]);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("matching environment credentials bypass an invalid auth file", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(join(home, "auth.json"), "{");
      process.env.SKIT_SERVER_URL = "https://environment.example/path";
      process.env.SKIT_TOKEN = "skit_pat_environment";

      expect(yield* resolveAuthForOriginEffect("https://environment.example", home)).toMatchObject({
        origin: "https://environment.example",
        token: "skit_pat_environment",
        source: "environment",
      });
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("an environment origin does not disguise a stored token as an environment token", () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const observed: Array<{ url: string; init?: RequestInit }> = [];
      yield* login(
        {
          origin: "https://stored.example",
          email: "user@example.test",
          password: "secret",
          scopes: ["library:sync"],
          home,
        },
        successfulServer(observed),
      );
      process.env.SKIT_SERVER_URL = "https://stored.example";
      delete process.env.SKIT_TOKEN;
      expect(yield* resolveAuthEffect(home)).toMatchObject({
        token: "skit_pat_secret_one",
        source: "stored",
      });
    }).pipe(Effect.provide(skitLayer)),
  );
});
