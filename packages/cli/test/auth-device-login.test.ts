import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
  addRegistryRemoteEffect,
  awaitDeviceApprovalEffect,
  loginEffect,
  readConfigEffect,
  readPendingLogin,
  savePendingLogin,
  startDeviceLoginEffect,
} from "../src/registry/auth.js";
import { authLoginCommand } from "../src/handlers/auth/login.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { skitConfigurationLayer } from "../src/configuration/skit-configuration.js";
import { testHttpClientLayer, type TestHttpHandler } from "./helpers/http-test-client.js";
import { testPlatformLayer } from "./helpers/platform.js";

const origin = "https://skit.example";

/** A Registry offering device authorization that answers each poll from `polls` in turn. */
function deviceServer(
  polls: ReadonlyArray<Response | Effect.Effect<Response>>,
  scopes: readonly string[] = ["library:sync"],
) {
  const seen: Array<{
    path: string;
    method: string;
    authorization?: string;
    cookie?: string;
    body?: string;
  }> = [];
  let poll = 0;
  const handler: TestHttpHandler = (request, url) => {
    seen.push({
      path: url.pathname,
      method: request.method,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      body:
        request.body._tag === "Uint8Array"
          ? new TextDecoder().decode(request.body.body)
          : undefined,
    });
    switch (url.pathname) {
      case "/.well-known/skit":
        return Effect.succeed(
          Response.json({
            schema: "skit.server.v1",
            download: "/api/skits/{owner}/{slug}/releases/{version}/download",
            scopes,
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
      case "/api/auth/device/token": {
        const answer = polls[poll++]!;
        return Effect.isEffect(answer) ? answer : Effect.succeed(answer.clone());
      }
      case "/api/tokens":
        return Effect.succeed(
          Response.json(
            {
              token: "skit_pat_secret",
              token_id: "pat_one",
              token_prefix: "skit_pat_sec",
              scopes,
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

/** The command's composition: start, wait for approval, then mint and store with that session. */
const deviceLogin = (polls: ReadonlyArray<Response>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-login-" });
    const server = deviceServer(polls);
    const scopes = ["library:sync" as const];
    const started = yield* Effect.scoped(startDeviceLoginEffect({ origin, scopes })).pipe(
      Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler))),
    );
    const approvals = [started];
    const result = yield* Effect.result(
      Effect.scoped(
        Effect.gen(function* () {
          const approvedSessionToken = yield* awaitDeviceApprovalEffect(started, scopes);
          return yield* loginEffect({ origin, scopes: [...scopes], home, approvedSessionToken });
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
      next: `skit auth login ${origin} --scopes library:sync --home ${home}`,
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

it.live(
  "the reported next command preserves scopes, alias, home and relogin through the shell",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-options-" });
      const home = join(root, "agent's $HOME");
      const scopes = ["authoring:write", "publication:write"];
      const server = deviceServer([Response.json({ access_token: "session-token" })], scopes);
      const interaction = yield* makeScriptedInteraction([]);
      const run = (options: Parameters<typeof authLoginCommand>[0]) =>
        authLoginCommand(options).pipe(
          Effect.provide(interaction.layer),
          Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler))),
        );
      const started = yield* run({
        registry: origin,
        home,
        scopes,
        alias: "private",
        relogin: true,
        interactive: false,
        browserApproval: true,
      });
      expect("next" in started).toBe(true);
      if (!("next" in started)) return;
      // Execute only a shell function that prints its arguments, so quoting is checked without
      // contacting a Registry or starting a real CLI process.
      const args = execFileSync(
        "/bin/sh",
        ["-c", `skit() { printf '%s\\n' "$@"; }\n${started.next}`],
        { encoding: "utf8" },
      )
        .trimEnd()
        .split("\n");
      expect(args).toEqual([
        "auth",
        "login",
        origin,
        "--scopes",
        scopes.join(","),
        "--as",
        "private",
        "--home",
        home,
        "--relogin",
      ]);
      const parsed = parseArgs({
        args: args.slice(2),
        allowPositionals: true,
        options: {
          scopes: { type: "string" },
          as: { type: "string" },
          home: { type: "string" },
          relogin: { type: "boolean" },
        },
      });
      const finished = yield* run({
        registry: parsed.positionals[0],
        home: parsed.values.home,
        scopes: parsed.values.scopes?.split(",") ?? ["library:sync"],
        alias: parsed.values.as,
        relogin: parsed.values.relogin,
        interactive: false,
        browserApproval: true,
      });
      expect(finished).toMatchObject({
        origin,
        alias: "private",
        scopes,
        alreadyAuthenticated: false,
      });
      expect(
        server.seen.filter((request) => request.path === "/api/auth/device/code"),
      ).toHaveLength(1);
      expect(
        JSON.parse(server.seen.find((request) => request.path === "/api/tokens")?.body ?? "{}"),
      ).toMatchObject({ scopes });
      expect(yield* readPendingLogin(origin, home)).toBeUndefined();
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.live("waiting for approval leaves the configuration writer free for other commands", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-unlocked-" });
    const polled = yield* Deferred.make<void>();
    const approve = yield* Deferred.make<void>();
    const server = deviceServer([
      Deferred.succeed(polled, undefined).pipe(
        Effect.andThen(Deferred.await(approve)),
        Effect.as(Response.json({ access_token: "session-token", token_type: "Bearer" })),
      ),
    ]);
    yield* savePendingLogin(
      {
        origin,
        deviceCode: "device-secret",
        userCode: "ABCDEFGH",
        verificationUri: `${origin}/device`,
        interval: 0,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
      home,
    ).pipe(Effect.provide(skitConfigurationLayer(home)));
    const waiting = yield* Effect.forkChild(
      Effect.gen(function* () {
        const interaction = yield* makeScriptedInteraction([]);
        return yield* authLoginCommand({
          registry: origin,
          home,
          scopes: ["library:sync"],
          interactive: false,
          browserApproval: true,
        }).pipe(Effect.provide(interaction.layer));
      }).pipe(Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler)))),
    );
    yield* Deferred.await(polled);

    // A configuration write succeeds while the login waits on the person.
    yield* addRegistryRemoteEffect("other", "https://other.example", home).pipe(
      Effect.provide(skitConfigurationLayer(home)),
    );
    yield* Deferred.succeed(approve, undefined);
    expect(yield* Fiber.join(waiting)).toMatchObject({ origin, alreadyAuthenticated: false });
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.live("a credential failure after redemption discards the consumed code", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-consumed-" });
    const server = deviceServer([Response.json({ access_token: "session-token" })]);
    const run = Effect.gen(function* () {
      const interaction = yield* makeScriptedInteraction([]);
      return yield* authLoginCommand({
        registry: origin,
        home,
        scopes: ["library:sync"],
        interactive: false,
        browserApproval: true,
      }).pipe(Effect.provide(interaction.layer));
    }).pipe(
      Effect.provide(
        registryHttpLayer(
          testHttpClientLayer((request, url, signal) =>
            url.pathname === "/api/tokens"
              ? Effect.succeed(Response.json({ error: "unauthorized" }, { status: 401 }))
              : server.handler(request, url, signal),
          ),
        ),
      ),
    );
    yield* run;
    expect(
      yield* readPendingLogin(origin, home).pipe(Effect.provide(skitConfigurationLayer(home))),
    ).toBeDefined();
    expect((yield* Effect.result(run))._tag).toBe("Failure");
    expect(
      yield* readPendingLogin(origin, home).pipe(Effect.provide(skitConfigurationLayer(home))),
    ).toBeUndefined();
    const restarted = yield* run;
    expect("verificationUri" in restarted).toBe(true);
    expect(server.seen.filter((request) => request.path === "/api/auth/device/code")).toHaveLength(
      2,
    );
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.live("an invalid saved device code is cleared so the next login can start again", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-invalid-" });
    const server = deviceServer([Response.json({ error: "invalid_grant" }, { status: 400 })]);
    const run = Effect.gen(function* () {
      const interaction = yield* makeScriptedInteraction([]);
      return yield* authLoginCommand({
        registry: origin,
        home,
        scopes: ["library:sync"],
        interactive: false,
        browserApproval: true,
      }).pipe(Effect.provide(interaction.layer));
    }).pipe(Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler))));
    yield* run;
    const failure = yield* Effect.result(run);
    expect(failure).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DeviceLoginEnded", reason: "invalid" },
    });
    expect(
      yield* readPendingLogin(origin, home).pipe(Effect.provide(skitConfigurationLayer(home))),
    ).toBeUndefined();
    expect("verificationUri" in (yield* run)).toBe(true);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
