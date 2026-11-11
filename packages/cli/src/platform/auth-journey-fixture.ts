import { Effect, Layer, Redacted, Ref, Schema, Sink, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import { registryHttpLayer } from "../registry/registry-http.js";

/** The fixture Registry's origin. */
export const authJourneyOrigin = "https://registry.example";

const TokenRequest = Schema.fromJsonString(
  Schema.Struct({ scopes: Schema.Array(Schema.String), expires_at: Schema.String }),
);

/**
 * A Registry offering browser (device) login: discovery, a device code, a token endpoint that
 * reports one `authorization_pending` before the person approves, credential minting, session
 * sign-out and credential revocation. It checks the bearer on each step, not real accounts.
 */
const makeAuthRegistry = Effect.gen(function* () {
  const polls = yield* Ref.make(0);
  const revoked = yield* Ref.make<ReadonlyArray<string>>([]);
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const path = url.pathname;
      const bearer = request.headers.authorization;
      let response: Response;
      if (request.method === "GET" && path === "/.well-known/skit") {
        response = Response.json({
          schema: "skit.server.v1",
          download: "/api/skits/{owner}/{slug}/releases/{version}/download",
          scopes: ["library:sync", "authoring:write", "publication:write"],
          deviceAuthorization: "/api/auth/device/code",
          deviceToken: "/api/auth/device/token",
        });
      } else if (request.method === "POST" && path === "/api/auth/device/code") {
        response = Response.json({
          device_code: "fixture-device-code",
          user_code: "WDJBMJHT",
          verification_uri: `${authJourneyOrigin}/device`,
          expires_in: 600,
          interval: 0,
        });
      } else if (request.method === "POST" && path === "/api/auth/device/token") {
        // The person approves in the browser while the CLI waits through one poll.
        response =
          (yield* Ref.getAndUpdate(polls, (count) => count + 1)) === 0
            ? Response.json({ error: "authorization_pending" }, { status: 400 })
            : Response.json({ access_token: "fixture-session", token_type: "Bearer" });
      } else if (request.method === "POST" && path === "/api/tokens") {
        const input = yield* Schema.decodeEffect(TokenRequest)(
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        );
        response =
          bearer === "Bearer fixture-session"
            ? Response.json(
                {
                  token: "skit_pat_fixture_credential",
                  token_id: "pat_fixture",
                  token_prefix: "skit_pat_fix",
                  scopes: input.scopes,
                  expires_at: input.expires_at,
                },
                { status: 201 },
              )
            : Response.json({ error: "session_required" }, { status: 401 });
      } else if (request.method === "POST" && path === "/api/auth/sign-out") {
        response = Response.json({ success: true });
      } else if (request.method === "DELETE" && path.startsWith("/api/tokens/")) {
        const id = decodeURIComponent(path.slice("/api/tokens/".length));
        if (bearer === "Bearer skit_pat_fixture_credential" && id === "pat_fixture") {
          yield* Ref.update(revoked, (ids) => [...ids, id]);
          response = new Response(null, { status: 204 });
        } else {
          response = Response.json({ error: "token_not_found" }, { status: 404 });
        }
      } else {
        response = new Response(`Unexpected fixture request: ${request.method} ${path}`, {
          status: 501,
        });
      }
      return HttpClientResponse.fromWeb(request, response);
    }).pipe(Effect.orDie),
  );
  return { client, revoked: Ref.get(revoked) };
});

/**
 * The machine's processes: a browser opener that records what it was asked to open, and no usable
 * OS credential store, so the credential is kept in the home's 0600 auth.json. Nothing reaches the
 * real browser or keychain.
 */
const makeMachine = Effect.gen(function* () {
  const opened = yield* Ref.make<ReadonlyArray<string>>([]);
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("The auth journey runs no pipelines");
      const args = command.args.map((arg) => (typeof arg === "string" ? arg : Redacted.value(arg)));
      const store = command.command === "/usr/bin/security" || command.command === "secret-tool";
      if (!store) yield* Ref.update(opened, (urls) => [...urls, ...args]);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(store ? 1 : 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  return { spawner, opened: Ref.get(opened) };
});

/** A disposable SKIT home with no stored credential, a fixture Registry and a fixture machine. */
export const makeAuthJourneyFixture = Effect.fn("Storybook.makeAuthJourneyFixture")(function* (
  root: string,
) {
  const registry = yield* makeAuthRegistry;
  const machine = yield* makeMachine;
  return {
    home: join(root, "skit-home"),
    layer: Layer.mergeAll(
      registryHttpLayer(Layer.succeed(HttpClient.HttpClient, registry.client)),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, machine.spawner),
    ),
    /** Credential ids the Registry has revoked. */
    revoked: registry.revoked,
    /** Every argument the browser opener received. */
    opened: machine.opened,
  };
});
