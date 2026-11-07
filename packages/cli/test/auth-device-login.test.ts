import { systemError } from "effect/PlatformError";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { Deferred, Effect, Exit, Fiber, FileSystem, Order } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { addRegistryRemote, readConfig } from "../src/registry/auth.js";
import { readPendingLogin, type PendingDeviceLogin } from "../src/registry/device-login.js";
import { Registry } from "../src/registry/index.js";
import { authLoginCommand } from "../src/registry/commands/login.js";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import { testHttpClientLayer, type TestHttpHandler } from "./helpers/http-test-client.js";
import { testPlatformLayer } from "./helpers/platform.js";

const origin = "https://skit.example";

const savePendingLogin = Effect.fn("Test.writePendingLoginFixture")(function* (
  pending: PendingDeviceLogin,
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(
    join(home, "login-pending.json"),
    JSON.stringify({ scopes: ["library:sync"], ...pending }),
    {
      mode: 0o600,
    },
  );
});

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

it.live.each([
  { expires_in: "1e999", interval: "0" },
  { expires_in: "600", interval: "1e999" },
  { expires_in: "1e308", interval: "0" },
])("rejects unusable device authorization timing: %o", (timing) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-timing-" });
    const server = deviceServer([]);
    const handler: TestHttpHandler = (request, url, body) =>
      url.pathname === "/api/auth/device/code"
        ? Effect.succeed(
            new Response(
              `{"device_code":"secret","user_code":"CODE","verification_uri":"${origin}/device","expires_in":${timing.expires_in},"interval":${timing.interval}}`,
              { headers: { "content-type": "application/json" } },
            ),
          )
        : server.handler(request, url, body);
    const result = yield* Registry.prepareDeviceLogin({
      origin,
      scopes: ["library:sync"],
      home,
    }).pipe(Effect.provide(registryHttpLayer(testHttpClientLayer(handler))), Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SignInFailed" } });
    expect(yield* fs.exists(join(home, "login-pending.json"))).toBe(false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

/** The command's composition: start, wait for approval, then mint and store with that session. */
const deviceLogin = (polls: ReadonlyArray<Response>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-login-" });
    const server = deviceServer(polls);
    const scopes = ["library:sync" as const];
    const started = yield* Registry.prepareDeviceLogin({ origin, scopes, home }).pipe(
      Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler))),
    );
    const approvals = [started.pending];
    const result = yield* Registry.completeDeviceLogin({
      pending: started.pending,
      scopes,
      home,
    }).pipe(Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler))), Effect.result);
    const config = yield* readConfig(home).pipe(Effect.provide(skitConfigurationLayer(home)));
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
  "the continuation command preserves scopes, alias and home without restarting a forced login",
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
    yield* addRegistryRemote("other", "https://other.example", home).pipe(
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

it.live("concurrent browser login preparation publishes one reusable device code", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-concurrent-" });
    const server = deviceServer([]);
    const attempts = yield* Effect.all(
      [
        Registry.prepareDeviceLogin({ origin, home, scopes: ["library:sync"] }),
        Registry.prepareDeviceLogin({ origin, home, scopes: ["library:sync"] }),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler))));
    expect(attempts.map((attempt) => attempt.resumed).sort(Order.Boolean)).toEqual([false, true]);
    expect(attempts[0].pending).toEqual(attempts[1].pending);
    expect(server.seen.filter((request) => request.path === "/api/auth/device/code")).toHaveLength(
      2,
    );
    expect((yield* fs.stat(join(home, "login-pending.json"))).mode & 0o777).toBe(0o600);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.live.each(["approved", "denied"] as const)(
  "an older %s login cannot erase a newer pending code",
  (outcome) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-replacement-" });
      const polled = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const server = deviceServer([
        Deferred.succeed(polled, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.as(
            outcome === "approved"
              ? Response.json({ access_token: "session-token" })
              : Response.json({ error: "access_denied" }, { status: 400 }),
          ),
        ),
      ]);
      const operation = Effect.gen(function* () {
        const started = yield* Registry.prepareDeviceLogin({
          origin,
          home,
          scopes: ["library:sync"],
        });
        const waiting = yield* Registry.completeDeviceLogin({
          pending: started.pending,
          home,
          scopes: ["library:sync"],
        }).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(polled);
        const newer = { ...started.pending, deviceCode: "new-device-secret", userCode: "NEWERCOD" };
        yield* savePendingLogin(newer, home);
        yield* Deferred.succeed(finish, undefined);
        const result = yield* Fiber.join(waiting);
        expect(result._tag).toBe(outcome === "approved" ? "Success" : "Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({ _tag: "DeviceLoginEnded", reason: "denied" });
        expect(yield* readPendingLogin(origin, home)).toEqual(newer);
      });
      yield* operation.pipe(Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler))));
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.live("interrupted approval keeps its pending code and frees the writer", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-interrupted-" });
    const polled = yield* Deferred.make<void>();
    let finalized = false;
    const server = deviceServer([
      Deferred.succeed(polled, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      ),
    ]);
    yield* Effect.gen(function* () {
      const started = yield* Registry.prepareDeviceLogin({
        origin,
        home,
        scopes: ["library:sync"],
      });
      const waiting = yield* Registry.completeDeviceLogin({
        pending: started.pending,
        home,
        scopes: ["library:sync"],
      }).pipe(Effect.forkChild);
      yield* Deferred.await(polled);
      yield* Fiber.interrupt(waiting);
      expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true);
      expect(finalized).toBe(true);
      expect(yield* readPendingLogin(origin, home)).toEqual(started.pending);
      yield* addRegistryRemote("other", "https://other.example", home);
      expect(server.seen.some((request) => request.path === "/api/tokens")).toBe(false);
    }).pipe(Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler))));
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.live("failed pending publication keeps the old code and removes its temporary file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-atomic-" });
    const server = deviceServer([]);
    const expired = {
      origin,
      deviceCode: "old-code",
      userCode: "ABCDEFGH",
      verificationUri: `${origin}/device`,
      interval: 0,
      expiresAt: "2000-01-01T00:00:00.000Z",
      scopes: ["library:sync"] as const,
    };
    yield* savePendingLogin(expired, home);
    const path = join(home, "login-pending.json");
    const previous = yield* fs.readFileString(path);
    const renameError = systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "rename",
      pathOrDescriptor: path,
    });
    const failure = yield* Registry.prepareDeviceLogin({
      origin,
      home,
      scopes: ["library:sync"],
    }).pipe(
      Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler))),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        rename: () => Effect.fail(renameError),
      }),
      Effect.flip,
    );
    expect(failure).toBe(renameError);
    expect(yield* fs.readFileString(path)).toBe(previous);
    expect(
      (yield* fs.readDirectory(home)).filter((name) => name.startsWith("login-pending.json.tmp")),
    ).toEqual([]);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.live("expiration removes the matching saved code even though it is no longer reusable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-expired-" });
    const expired = {
      origin,
      deviceCode: "expired",
      userCode: "ABCDEFGH",
      verificationUri: `${origin}/device`,
      interval: 0,
      expiresAt: "2000-01-01T00:00:00.000Z",
      scopes: ["library:sync"] as const,
    };
    yield* savePendingLogin(expired, home);
    const server = deviceServer([]);
    const failure = yield* Registry.completeDeviceLogin({
      pending: expired,
      home,
      scopes: ["library:sync"],
    }).pipe(Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler))), Effect.flip);
    expect(failure).toMatchObject({ _tag: "DeviceLoginEnded", reason: "expired" });
    expect(yield* fs.exists(join(home, "login-pending.json"))).toBe(false);
    expect(server.seen.some((request) => request.path === "/api/auth/device/token")).toBe(false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.live.each(["discovery", "device-code"] as const)(
  "%s requests leave the home writer available",
  (stage) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-network-" });
      const requested = yield* Deferred.make<void>();
      const respond = yield* Deferred.make<void>();
      const server = deviceServer([]);
      const path = stage === "discovery" ? "/.well-known/skit" : "/api/auth/device/code";
      const handler: TestHttpHandler = (request, url, signal) =>
        url.pathname === path
          ? Deferred.succeed(requested, undefined).pipe(
              Effect.andThen(Deferred.await(respond)),
              Effect.andThen(server.handler(request, url, signal)),
            )
          : server.handler(request, url, signal);
      const starting = yield* Registry.prepareDeviceLogin({
        origin,
        home,
        scopes: ["library:sync"],
      }).pipe(Effect.provide(registryHttpLayer(testHttpClientLayer(handler))), Effect.forkChild);
      yield* Deferred.await(requested);
      yield* addRegistryRemote("other", "https://other.example", home).pipe(
        Effect.provide(skitConfigurationLayer(home)),
      );
      yield* Deferred.succeed(respond, undefined);
      expect((yield* Fiber.join(starting)).resumed).toBe(false);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.live("pending login reuse requires the same scopes and respects forced relogin", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-device-reuse-" });
    const server = deviceServer([], ["library:sync", "authoring:write"]);
    const prepare = (scopes: readonly ("library:sync" | "authoring:write")[], relogin = false) =>
      Registry.prepareDeviceLogin({ origin, home, scopes, relogin }).pipe(
        Effect.provide(registryHttpLayer(testHttpClientLayer(server.handler))),
      );
    expect((yield* prepare(["library:sync"])).resumed).toBe(false);
    expect((yield* prepare(["library:sync"])).resumed).toBe(true);
    expect((yield* prepare(["authoring:write"])).resumed).toBe(false);
    expect((yield* prepare(["authoring:write"], true)).resumed).toBe(false);
    expect((yield* prepare(["authoring:write"])).resumed).toBe(true);
    expect(server.seen.filter((request) => request.path === "/api/auth/device/code")).toHaveLength(
      3,
    );
    // Old pending records lack scope evidence and must start a fresh request.
    const { scopes: _scopes, ...legacy } = (yield* readPendingLogin(origin, home))!;
    yield* fs.writeFileString(join(home, "login-pending.json"), JSON.stringify(legacy));
    expect((yield* prepare(["authoring:write"])).resumed).toBe(false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
