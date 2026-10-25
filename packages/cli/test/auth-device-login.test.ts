import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
  type PendingDeviceLogin,
  loginEffect,
  readConfigEffect,
  readPendingLogin,
} from "../src/registry/auth.js";
import { authLoginCommand } from "../src/handlers/auth/login.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { skitConfigurationLayer } from "../src/configuration/skit-configuration.js";
import { testHttpClientLayer, type TestHttpHandler } from "./helpers/http-test-client.js";
import { testPlatformLayer } from "./helpers/platform.js";

const origin = "https://skit.example";

/** A Registry offering device authorization that answers each poll from `polls` in turn. */
function deviceServer(polls: ReadonlyArray<Response>) {
  const seen: Array<{ path: string; method: string; authorization?: string; cookie?: string }> = [];
  let poll = 0;
  const handler: TestHttpHandler = (request, url) => {
    seen.push({
      path: url.pathname,
      method: request.method,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    switch (url.pathname) {
      case "/.well-known/skit":
        return Effect.succeed(
          Response.json({
            schema: "skit.server.v1",
            download: "/api/skits/{owner}/{slug}/releases/{version}/download",
            scopes: ["library:sync"],
            deviceAuthorization: "/api/auth/device/code",
            deviceToken: "/api/auth/device/token",
          }),
        );
      case "/api/auth/device/code":
        return Effect.succeed(
          Response.json({
            device_code: "device-secret",
            user_code: "ABCDEFGH",
            verification_uri: `${origin}/device`,
            expires_in: 600,
            interval: 0,
          }),
        );
      case "/api/auth/device/token":
        return Effect.succeed(polls[poll++]!.clone());
      case "/api/tokens":
        return Effect.succeed(
          Response.json(
            {
              token: "skit_pat_secret",
              token_id: "pat_one",
              token_prefix: "skit_pat_sec",
              scopes: ["library:sync"],
            },
            { status: 201 },
          ),
        );
      case "/api/auth/sign-out":
        return Effect.succeed(Response.json({ success: true }));
      default:
        return Effect.succeed(new Response(null, { status: 404 }));
    }
  };
  return { handler, seen };
}

const pending = Response.json({ error: "authorization_pending" }, { status: 400 });

const deviceLogin = (polls: ReadonlyArray<Response>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-login-" });
    const server = deviceServer(polls);
    const approvals: PendingDeviceLogin[] = [];
    const result = yield* Effect.result(
      Effect.scoped(
        loginEffect({
          origin,
          scopes: ["library:sync"],
          home,
          onDeviceCode: (approval) => Effect.sync(() => approvals.push(approval)),
        }),
      ).pipe(Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler)))),
    );
    const config = yield* readConfigEffect(home).pipe(Effect.provide(skitConfigurationLayer(home)));
    return { result, approvals, seen: server.seen, stored: config.servers[origin]?.token };
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped);

it.live("mints and stores a credential once the user approves in the browser", () =>
  Effect.gen(function* () {
    const { result, approvals, seen, stored } = yield* deviceLogin([
      pending,
      pending,
      Response.json({ access_token: "session-token", token_type: "Bearer" }),
    ]);

    expect(result._tag).toBe("Success");
    expect(approvals).toMatchObject([
      { origin, userCode: "ABCDEFGH", verificationUri: `${origin}/device` },
    ]);
    expect(seen.filter((request) => request.path === "/api/auth/device/token")).toHaveLength(3);
    // The approved session mints the credential and is then signed out, as a password session is.
    for (const path of ["/api/tokens", "/api/auth/sign-out"])
      expect(seen.find((request) => request.path === path)).toMatchObject({
        method: "POST",
        authorization: "Bearer session-token",
      });
    expect(seen.some((request) => request.path === "/api/auth/sign-in/email")).toBe(false);
    expect(stored).toBe("skit_pat_secret");
  }),
);

it.live("stops polling and stores nothing when the user denies the login", () =>
  Effect.gen(function* () {
    const { result, seen, stored } = yield* deviceLogin([
      pending,
      Response.json({ error: "access_denied" }, { status: 400 }),
    ]);

    expect(result._tag === "Failure" && result.failure).toMatchObject({
      _tag: "DeviceLoginEnded",
      reason: "denied",
    });
    expect(seen.some((request) => request.path === "/api/tokens")).toBe(false);
    expect(stored).toBeUndefined();
  }),
);

it.live("an agent's login returns the code at once, and its next login waits for approval", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-agent-" });
    const server = deviceServer([
      pending,
      Response.json({ access_token: "session-token", token_type: "Bearer" }),
    ]);
    const agentLogin = Effect.gen(function* () {
      const interaction = yield* makeScriptedInteraction([]);
      return yield* authLoginCommand({
        registry: origin,
        home,
        scopes: ["library:sync"],
        interactive: false,
        browserApproval: true,
      }).pipe(Effect.provide(interaction.layer));
    }).pipe(Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler))));

    const started = yield* agentLogin;
    expect(started).toMatchObject({
      origin,
      userCode: "ABCD-EFGH",
      verificationUri: `${origin}/device`,
      next: `skit auth login ${origin}`,
    });
    expect(server.seen.some((request) => request.path === "/api/auth/device/token")).toBe(false);
    expect((yield* readPendingLogin(origin, home))?.deviceCode).toBe("device-secret");
    // The device code redeems for a session until it expires, so it is kept as private as a token.
    expect((yield* fs.stat(join(home, "login-pending.json"))).mode & 0o777).toBe(0o600);

    const finished = yield* agentLogin;
    expect(finished).toMatchObject({ origin, alreadyAuthenticated: false });
    expect(server.seen.filter((request) => request.path === "/api/auth/device/code")).toHaveLength(
      1,
    );
    expect(yield* readPendingLogin(origin, home)).toBeUndefined();
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
