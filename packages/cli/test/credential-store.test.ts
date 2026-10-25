import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import { skitConfigurationLayer } from "../src/configuration/skit-configuration.js";
import { addRegistryRemoteEffect, readConfigEffect } from "../src/registry/auth.js";
import {
  readStoredToken,
  removeStoredToken,
  writeStoredToken,
} from "../src/registry/credential-store.js";
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
      assert.deepStrictEqual(written.servers[origin], { tokenStorage: "secret-service" });
      assert.lengthOf(yield* fs.readDirectory(store), 1);
      const config = yield* readConfigEffect(home).pipe(
        Effect.provide(skitConfigurationLayer(home)),
      );
      assert.strictEqual(config.servers[origin]?.token, "skit_pat_inline");
    }),
  ).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
