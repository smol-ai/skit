import { join } from "node:path";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect, FileSystem, Schema } from "effect";
import { HttpClientError } from "effect/http";
import { systemError } from "effect/PlatformError";
import { loginEffect, registryCredentials } from "../src/registry/auth.js";
import { SignInFailed, authCleanupDetails } from "../src/registry/auth-failures.js";
import { RegistryTransportError } from "../src/registry/request-failures.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { commandError } from "../src/commands/failure-classification.js";
import { CommandError } from "../src/commands/error-output.js";
import { result } from "../src/commands/result.js";
import { defaultTerminalEnvironment, renderResultFrame } from "../src/commands/output-frame.js";
import { Block } from "../src/terminal/blocks.js";
import { testPlatformLayer } from "./helpers/platform.js";
import { testHttpClientLayer, type TestHttpHandler } from "./helpers/http-test-client.js";

const input = (home: string) => ({
  origin: "https://registry.test",
  email: "user@example.test",
  password: "fake-password",
  scopes: ["library:sync" as const],
  home,
});
const login = (home: string, handler: TestHttpHandler) =>
  Effect.scoped(
    loginEffect(input(home)).pipe(Effect.provide(registryHttpLayer(testHttpClientLayer(handler)))),
  );
const authHome = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "skit-auth-cleanup-" }),
);

/** Only fake credentials; the production Registry transport wraps these injected HTTP failures. */
function successfulServer(): TestHttpHandler {
  let minted = 0;
  return (_request, url) =>
    Effect.sync(() => {
      if (url.pathname === "/.well-known/skit")
        return Response.json({
          schema: "skit.server.v1",
          download: "/api/skits/{owner}/{slug}/releases/{version}/download",
          scopes: ["library:sync"],
        });
      if (url.pathname === "/api/auth/sign-in/email")
        return new Response("{}", {
          headers: { "set-cookie": "skit-auth.session_token=fake-session; Path=/; HttpOnly" },
        });
      if (url.pathname === "/api/tokens") {
        const id = ++minted;
        return Response.json(
          {
            token: `fake-credential-secret-${id}`,
            token_id: `pat_${id}`,
            token_prefix: `fake-prefix-${id}`,
            scopes: ["library:sync"],
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/api/auth/sign-out") return Response.json({ success: true });
      return new Response(null, { status: 204 });
    });
}

it.effect("keeps creation rejection when session cleanup loses its connection", () =>
  Effect.gen(function* () {
    const home = yield* authHome;
    const base = successfulServer();
    const native = new Error("Session response lost");
    const seen: string[] = [];
    const handler: TestHttpHandler = (request, url, signal) => {
      seen.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/tokens")
        return Effect.succeed(Response.json({ error: "unauthorized" }, { status: 401 }));
      if (url.pathname === "/api/auth/sign-out")
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: native }),
          }),
        );
      return base(request, url, signal);
    };
    const failure = yield* login(home, handler).pipe(Effect.flip);
    expect(failure).toMatchObject({
      _tag: "SignInFailed",
      reason: {
        _tag: "SessionEndFailed",
        cleanup: { _tag: "RequestFailed" },
        original: { _tag: "SignInRejected", operation: "credential-create" },
      },
    });
    if (
      !Schema.is(SignInFailed)(failure) ||
      failure.reason._tag !== "SessionEndFailed" ||
      failure.reason.cleanup._tag !== "RequestFailed"
    )
      return yield* Effect.die("Expected failed session cleanup");
    const transport = failure.reason.cleanup.failure;
    expect(Schema.is(RegistryTransportError)(transport)).toBe(true);
    if (Schema.is(RegistryTransportError)(transport)) expect(transport.cause.cause).toBe(native);
    expect(failure.reason.cleanup).not.toHaveProperty("status");
    expect(seen).toEqual([
      "GET /.well-known/skit",
      "POST /api/auth/sign-in/email",
      "POST /api/tokens",
      "POST /api/auth/sign-out",
    ]);
    expect(yield* registryCredentials({ home })).toMatchObject({ source: "none" });
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "reports both lost cleanup responses without retrying or saving the minted credential",
  () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const base = successfulServer();
      const seen: string[] = [];
      const failures = {
        session: new Error("Session response lost"),
        credential: new Error("Credential response lost"),
      };
      const handler: TestHttpHandler = (request, url, signal) => {
        seen.push(`${request.method} ${url.pathname}`);
        const cause =
          url.pathname === "/api/auth/sign-out"
            ? failures.session
            : request.method === "DELETE"
              ? failures.credential
              : undefined;
        return cause
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause }),
              }),
            )
          : base(request, url, signal);
      };
      const failure = yield* login(home, handler).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "SignInFailed",
        reason: {
          _tag: "SessionEndFailed",
          cleanup: { _tag: "RequestFailed" },
          credential: { tokenId: "pat_1", cleanup: { _tag: "RequestFailed" } },
        },
      });
      if (
        !Schema.is(SignInFailed)(failure) ||
        failure.reason._tag !== "SessionEndFailed" ||
        failure.reason.cleanup._tag !== "RequestFailed" ||
        failure.reason.credential?.cleanup._tag !== "RequestFailed"
      )
        return yield* Effect.die("Expected both cleanup failures");
      const session = failure.reason.cleanup.failure;
      const credential = failure.reason.credential.cleanup.failure;
      if (
        !Schema.is(RegistryTransportError)(session) ||
        !Schema.is(RegistryTransportError)(credential)
      )
        return yield* Effect.die("Expected native Registry transport failures");
      expect(session.cause.cause).toBe(failures.session);
      expect(credential.cause.cause).toBe(failures.credential);
      const wire = yield* Schema.encodeEffect(CommandError)(commandError(Cause.fail(failure)));
      const decoded = yield* Schema.decodeUnknownEffect(CommandError)(
        JSON.parse(JSON.stringify(wire)),
      );
      const recovered = decoded.cause.reasons[0];
      expect(recovered).toMatchObject({
        _tag: "Fail",
        error: {
          reason: {
            _tag: "SessionEndFailed",
            cleanup: { _tag: "RequestFailed", failure: { _tag: "RegistryTransportError" } },
            credential: {
              cleanup: { _tag: "RequestFailed", failure: { _tag: "RegistryTransportError" } },
            },
          },
        },
      });
      expect(recovered).toMatchObject({
        _tag: "Fail",
        error: {
          reason: {
            cleanup: { failure: { cause: { cause: { message: "Session response lost" } } } },
            credential: {
              cleanup: { failure: { cause: { cause: { message: "Credential response lost" } } } },
            },
          },
        },
      });
      expect(recovered).toMatchObject({
        _tag: "Fail",
        error: {
          reason: {
            cleanup: { failure: { cause: { cause: { message: "Session response lost" } } } },
            credential: {
              cleanup: { failure: { cause: { cause: { message: "Credential response lost" } } } },
            },
          },
        },
      });
      expect(JSON.stringify(wire)).not.toContain("fake-credential-secret-");
      expect(seen).toEqual([
        "GET /.well-known/skit",
        "POST /api/auth/sign-in/email",
        "POST /api/tokens",
        "POST /api/auth/sign-out",
        "DELETE /api/tokens/pat_1",
      ]);
      expect(yield* registryCredentials({ home })).toMatchObject({ source: "none" });
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("keeps the exact storage failure alongside a lost credential-cleanup response", () =>
  Effect.gen(function* () {
    const home = yield* authHome;
    const fs = yield* FileSystem.FileSystem;
    const path = join(home, "auth.json");
    const original = systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "rename",
      pathOrDescriptor: path,
    });
    const native = new Error("Cleanup response lost");
    const seen: string[] = [];
    const base = successfulServer();
    const handler: TestHttpHandler = (request, url, signal) => {
      seen.push(`${request.method} ${url.pathname}`);
      return request.method === "DELETE"
        ? Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: native }),
            }),
          )
        : base(request, url, signal);
    };
    const failure = yield* login(home, handler).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        rename: (from, to) => (to === path ? Effect.fail(original) : fs.rename(from, to)),
      }),
      Effect.flip,
    );
    expect(failure).toMatchObject({
      _tag: "SignInFailed",
      reason: {
        _tag: "StorageCleanupFailed",
        tokenId: "pat_1",
        cleanup: { _tag: "RequestFailed" },
      },
    });
    if (
      !Schema.is(SignInFailed)(failure) ||
      failure.reason._tag !== "StorageCleanupFailed" ||
      failure.reason.cleanup._tag !== "RequestFailed"
    )
      return yield* Effect.die("Expected failed storage and cleanup");
    expect(failure.reason.original).toBe(original);
    const transport = failure.reason.cleanup.failure;
    if (Schema.is(RegistryTransportError)(transport)) expect(transport.cause.cause).toBe(native);
    else return yield* Effect.die("Expected Registry transport failure");
    expect(seen).toEqual([
      "GET /.well-known/skit",
      "POST /api/auth/sign-in/email",
      "POST /api/tokens",
      "POST /api/auth/sign-out",
      "DELETE /api/tokens/pat_1",
    ]);
    expect(yield* fs.exists(path)).toBe(false);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "returns the saved new credential with a warning after losing the old credential's revocation response",
  () =>
    Effect.gen(function* () {
      const home = yield* authHome;
      const base = successfulServer();
      const native = new Error("Revocation response lost");
      const revoked: string[] = [];
      const handler: TestHttpHandler = (request, url, signal) => {
        if (request.method === "DELETE") {
          revoked.push(url.pathname);
          // The server may have revoked it even though its response never arrived.
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: native }),
            }),
          );
        }
        return base(request, url, signal);
      };
      yield* login(home, handler);
      const loggedIn = yield* login(home, handler);
      expect(loggedIn.warning).toMatchObject({
        _tag: "PreviousCredentialNotRevoked",
        tokenId: "pat_1",
        cleanup: { _tag: "RequestFailed" },
      });
      expect(yield* registryCredentials({ home })).toMatchObject({
        tokenId: "pat_2",
        token: "fake-credential-secret-2",
      });
      expect(revoked).toEqual(["/api/tokens/pat_1"]);
      const wire = renderResultFrame(result("authLogin", loggedIn), {
        ...defaultTerminalEnvironment,
        format: "json",
      });
      const data = JSON.parse(wire.stdout).data;
      expect(data.warning.cleanup).toMatchObject({
        _tag: "RequestFailed",
        failure: {
          _tag: "RegistryTransportError",
          cause: { cause: { message: "Revocation response lost" } },
        },
      });
      expect(data.warning.cleanup).not.toHaveProperty("status");
      expect(data).not.toHaveProperty("token");
      if (loggedIn.warning)
        expect(authCleanupDetails(loggedIn.warning.cleanup)).toContainEqual(
          Block.Note({ text: ["No cleanup response was received."] }),
        );
    }).pipe(Effect.provide(testPlatformLayer)),
);
