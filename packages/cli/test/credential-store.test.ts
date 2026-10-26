import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import { skitConfigurationLayer } from "../src/configuration/skit-configuration.js";
import { addRegistryRemoteEffect, loginEffect, readConfigEffect } from "../src/registry/auth.js";
import {
  readStoredToken,
  removeStoredToken,
  writeStoredToken,
} from "../src/registry/credential-store.js";
import { systemError } from "effect/PlatformError";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { testHttpClientLayer } from "./helpers/http-test-client.js";
import { testPlatformLayer } from "./helpers/platform.js";

// A stand-in for libsecret's `secret-tool`: the same arguments and stdin/stdout contract, backed by
// files, so these tests exercise the OS-store path without touching the developer's real store.
const fakeSecretTool = `#!/bin/sh
command="$1"; shift
service=""; account=""
while [ $# -gt 0 ]; do
  case "$1" in
    service) service="$2"; shift ;;
    account) account="$2"; shift ;;
  esac
  shift
done
item="$FAKE_SECRET_STORE/$(printf '%s|%s' "$service" "$account" | shasum | cut -c1-40)"
case "$command" in
  store) cat > "$item" ;;
  lookup) [ -f "$item" ] && cat "$item" || exit 1 ;;
  clear) rm -f "$item" ;;
esac
`;

const withFakeSecretService = <A, E, R>(effect: (store: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-secret-service-" });
    const store = join(root, "store");
    yield* fs.makeDirectory(join(root, "bin"), { recursive: true });
    yield* fs.makeDirectory(store);
    yield* fs.writeFileString(join(root, "bin", "secret-tool"), fakeSecretTool, { mode: 0o755 });
    const previous = {
      PATH: process.env.PATH,
      SKIT_CREDENTIAL_STORE: process.env.SKIT_CREDENTIAL_STORE,
      FAKE_SECRET_STORE: process.env.FAKE_SECRET_STORE,
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(previous))
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      }),
    );
    process.env.PATH = `${join(root, "bin")}:${previous.PATH ?? ""}`;
    process.env.SKIT_CREDENTIAL_STORE = "secret-service";
    process.env.FAKE_SECRET_STORE = store;
    return yield* effect(store);
  });

it.effect("stores, reads and removes a token through the OS store's command-line tool", () =>
  withFakeSecretService((store) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const origin = "https://registry.example.test";
      assert.isTrue(
        yield* writeStoredToken("secret-service", "/a/auth.json", origin, "skit_pat_1"),
      );
      assert.strictEqual(
        yield* readStoredToken("secret-service", "/a/auth.json", origin),
        "skit_pat_1",
      );
      // Another SKIT home keeps its own item for the same Registry.
      assert.isUndefined(yield* readStoredToken("secret-service", "/b/auth.json", origin));
      yield* removeStoredToken("secret-service", "/a/auth.json", origin);
      assert.isUndefined(yield* readStoredToken("secret-service", "/a/auth.json", origin));
      assert.deepStrictEqual(yield* fs.readDirectory(store), []);
    }),
  ).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

const StoredFile = Schema.fromJsonString(
  Schema.Struct({
    servers: Schema.Record(
      Schema.String,
      Schema.Struct({
        token: Schema.optionalKey(Schema.String),
        tokenStorage: Schema.optionalKey(Schema.String),
        tokenStorageKey: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
);

it.effect("the next write moves a token from auth.json into the OS store", () =>
  withFakeSecretService((store) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-auth-home-" });
      const origin = "https://registry.example.test";
      yield* fs.writeFileString(
        join(home, "auth.json"),
        JSON.stringify({
          schemaVersion: 1,
          servers: {
            [origin]: {
              token: "skit_pat_inline",
              tokenId: "token-1",
              tokenPrefix: "skit_pat_in",
              scopes: ["library:sync"],
            },
          },
        }),
      );

      yield* addRegistryRemoteEffect("other", "https://other.example.test", home).pipe(
        Effect.provide(skitConfigurationLayer(home)),
      );

      const written = Schema.decodeUnknownSync(StoredFile)(
        yield* fs.readFileString(join(home, "auth.json")),
      );
      assert.deepStrictEqual(written.servers[origin], {
        tokenStorage: "secret-service",
        tokenStorageKey: "token-1",
      });
      assert.lengthOf(yield* fs.readDirectory(store), 1);
      const config = yield* readConfigEffect(home).pipe(
        Effect.provide(skitConfigurationLayer(home)),
      );
      assert.strictEqual(config.servers[origin]?.token, "skit_pat_inline");
    }),
  ).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("failed credential publication preserves the previous OS-store credential", () =>
  withFakeSecretService((store) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const key of [undefined, "old-id"]) {
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-auth-rollback-" });
        const path = join(home, "auth.json");
        const origin = "https://registry.example.test";
        yield* writeStoredToken("secret-service", path, origin, "old-token", key);
        yield* fs.writeFileString(
          path,
          JSON.stringify({
            schemaVersion: 1,
            servers: {
              [origin]: {
                tokenStorage: "secret-service",
                ...(key ? { tokenStorageKey: key } : {}),
                tokenId: "old-id",
                tokenPrefix: "old",
                scopes: ["library:sync"],
              },
            },
          }),
        );
        const revoked: string[] = [];
        const transport = testHttpClientLayer((_request, url) =>
          Effect.sync(() => {
            if (url.pathname === "/.well-known/skit")
              return Response.json({
                schema: "skit.server.v1",
                download: "/download",
                scopes: ["library:sync"],
              });
            if (url.pathname === "/api/tokens")
              return Response.json(
                {
                  token: "new-token",
                  token_id: "new-id",
                  token_prefix: "new",
                  scopes: ["library:sync"],
                },
                { status: 201 },
              );
            if (url.pathname.startsWith("/api/tokens/")) revoked.push(url.pathname);
            return Response.json({ success: true });
          }),
        );
        const result = yield* Effect.result(
          loginEffect({
            origin,
            home,
            approvedSessionToken: "session",
            scopes: ["library:sync"],
          }).pipe(
            Effect.provide(registryHttpLayer(transport)),
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              rename: (from, to) =>
                to === path
                  ? Effect.fail(
                      systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "rename",
                        pathOrDescriptor: to,
                      }),
                    )
                  : fs.rename(from, to),
            }),
            Effect.provide(skitConfigurationLayer(home)),
          ),
        );
        assert.strictEqual(result._tag, "Failure");
        const config = yield* readConfigEffect(home).pipe(
          Effect.provide(skitConfigurationLayer(home)),
        );
        assert.strictEqual(config.servers[origin]?.token, "old-token");
        assert.strictEqual(config.servers[origin]?.tokenId, "old-id");
        assert.deepStrictEqual(revoked, ["/api/tokens/new-id"]);
        assert.isUndefined(yield* readStoredToken("secret-service", path, origin, "new-id"));
        yield* removeStoredToken("secret-service", path, origin, key);
      }
      assert.deepStrictEqual(yield* fs.readDirectory(store), []);
    }),
  ).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a successful write migrates a legacy OS-store item after publishing its new key", () =>
  withFakeSecretService((store) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-auth-legacy-" });
      const path = join(home, "auth.json");
      const origin = "https://registry.example.test";
      yield* writeStoredToken("secret-service", path, origin, "legacy-token");
      yield* fs.writeFileString(
        path,
        JSON.stringify({
          schemaVersion: 1,
          servers: {
            [origin]: {
              tokenStorage: "secret-service",
              tokenId: "legacy-id",
              tokenPrefix: "legacy",
              scopes: ["library:sync"],
            },
          },
        }),
      );
      yield* addRegistryRemoteEffect("other", "https://other.example.test", home).pipe(
        Effect.provide(skitConfigurationLayer(home)),
      );
      const config = yield* readConfigEffect(home).pipe(
        Effect.provide(skitConfigurationLayer(home)),
      );
      assert.strictEqual(config.servers[origin]?.token, "legacy-token");
      assert.strictEqual(config.servers[origin]?.tokenStorageKey, "legacy-id");
      assert.isUndefined(yield* readStoredToken("secret-service", path, origin));
      assert.lengthOf(yield* fs.readDirectory(store), 1);
    }),
  ).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
