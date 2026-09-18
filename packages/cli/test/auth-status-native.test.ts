import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { authStatusCommand } from "../src/registry/auth.js";
import { skitLayer } from "@smolai/skit-core";

it.effect("returns every stored authentication record", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-auth-status-" });
    yield* fs.writeFileString(
      join(home, "auth.json"),
      JSON.stringify({
        schemaVersion: 1,
        defaultRegistry: "work",
        registryAliases: { work: "https://one.example", mirror: "https://two.example" },
        servers: {
          "https://one.example": {
            token: "secret-one",
            tokenId: "one",
            tokenPrefix: "secret-one",
            scopes: ["authoring:write"],
          },
          "https://two.example": {
            token: "secret-two",
            tokenId: "two",
            tokenPrefix: "secret-two",
            scopes: ["library:sync"],
          },
        },
      }),
    );
    const value = yield* authStatusCommand(home);
    assert.deepStrictEqual(value, {
      credentials: [
        {
          aliases: ["work"],
          expired: false,
          expiry: "unknown",
          isDefault: true,
          origin: "https://one.example",
          scopes: ["authoring:write"],
          source: "stored",
          tokenPrefix: "secret-one",
        },
        {
          aliases: ["mirror"],
          expired: false,
          expiry: "unknown",
          isDefault: false,
          origin: "https://two.example",
          scopes: ["library:sync"],
          source: "stored",
          tokenPrefix: "secret-two",
        },
      ],
    });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("preserves an invalid credential-file failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-auth-status-invalid-" });
    yield* fs.writeFileString(join(home, "auth.json"), "{");
    const actual = yield* Effect.flip(authStatusCommand(home));
    assert.strictEqual(actual._tag, "CredentialsUnusable");
  }).pipe(Effect.provide(skitLayer)),
);
