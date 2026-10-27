import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { join } from "node:path";
import { inspectLibrarySource } from "../src/library-application/source-acquisition.js";
import { RegistryAccounts, officialRegistryOrigin } from "../src/registry/accounts.js";
import { libraryHome, scratch } from "./helpers/library-home.js";
import { testPlatformLayer } from "./helpers/platform.js";

// With no Registry configured, `skit:` shorthand means smol.ai's hosted Registry. A configured
// Registry, SKIT_SERVER_URL or an explicit authority still wins (see registry-remotes tests).
it.effect("resolves skit: shorthand against the hosted Registry when none is configured", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-hosted-default-");
    const requested: string[] = [];
    const home = yield* libraryHome({
      home: join(root, "library"),
      transport: (_request, url) =>
        Effect.sync(() => {
          requested.push(url.href);
          return new Response("not found", { status: 404 });
        }),
    });

    yield* Effect.exit(home.owned(inspectLibrarySource("skit:alice/tools@1.0.0")));

    assert.deepStrictEqual(requested, [
      `${officialRegistryOrigin}/api/skits/alice/tools/releases/1.0.0/download`,
    ]);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("names the hosted Registry `smol` on first sign-in", () =>
  Effect.sync(() => {
    const signedIn = new RegistryAccounts({ schemaVersion: 1, servers: {} }).signedIn(
      officialRegistryOrigin,
      { token: "t", tokenId: "id", tokenPrefix: "t", scopes: ["library:sync"] },
    );
    assert.strictEqual(signedIn.alias, "smol");
    assert.strictEqual(signedIn.config.defaultRegistry, "smol");
  }),
);
