import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { LibraryStore } from "@smolai/skit-core";
import { join } from "node:path";
import { ConfigProvider, Effect, FileSystem, Layer, Result } from "effect";
import { HttpClient } from "effect/http";
import { authorSyncCommand } from "../src/handlers/author/sync.js";
import { librarySyncCommand } from "../src/handlers/library/sync.js";
import { CredentialsUnusable } from "../src/registry/failures.js";
import { RegistryHttp, registryClient, registryHttpLayer } from "../src/registry/registry-http.js";
import { skitConfigurationLayer } from "../src/configuration/skit-configuration.js";
import { testHttpClientLayer } from "./helpers/http-test-client.js";
import { scratch } from "./helpers/library-home.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import { MissingRequirement } from "../src/workflows/failures.js";

const failure = new CredentialsUnusable({ path: "/broken/auth.json", reason: "invalid" });

const services = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(rendererTestLayer()),
    Effect.provide(testPlatformLayer),
    Effect.provideService(
      LibraryStore,
      LibraryStore.of({
        load: Effect.die("unreachable"),
        inspect: Effect.die("unreachable"),
        save: () => Effect.die("unreachable"),
        home: "/unreachable",
        originalsPath: "/unreachable/originals",
        statePath: "/unreachable/state.json",
        variantsPath: "/unreachable/variants",
      }),
    ),
    Effect.provideService(
      RegistryHttp,
      RegistryHttp.of({
        client: Effect.succeed(registryClient(HttpClient.make(() => Effect.die("unreachable")))),
      }),
    ),
  );

it.effect("author sync reports missing first-sync arguments before ambient authentication", () =>
  services(
    authorSyncCommand({
      apply: false,
      authState: Result.fail(failure),
    }),
  ).pipe(
    Effect.flip,
    Effect.map((actual) =>
      assert.deepStrictEqual(
        actual,
        new MissingRequirement({
          command: "First author sync",
          requires: "--to <namespace/skit> and --visibility <private|unlisted|public>",
        }),
      ),
    ),
  ),
);

it.effect("Library sync preserves credential configuration failures", () =>
  services(
    librarySyncCommand({
      authState: Result.fail(failure),
      apply: false,
      adopt: false,
      projection: { rootFor: () => undefined },
    }),
  ).pipe(
    Effect.flip,
    Effect.map((actual) => assert.strictEqual(actual, failure)),
  ),
);

it.effect("author sync never sends an environment token to another Registry's remote", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* scratch("skit-sync-environment-token-");
    const home = yield* scratch("skit-sync-environment-home-");
    yield* fs.makeDirectory(join(root, "skills", "review"), { recursive: true });
    yield* fs.writeFileString(
      join(root, "skit.json"),
      JSON.stringify({
        slug: "tools",
        skills: [{ name: "review", path: "skills/review", invocation: "explicit" }],
      }),
    );
    yield* fs.writeFileString(
      join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code.\n---\n# Review\n",
    );
    yield* fs.writeFileString(
      join(root, "skit.remote.json"),
      JSON.stringify({
        schema: "skit.remote.v1",
        origin: "https://stored.example",
        namespace: "tim",
        skit: "tools",
      }),
    );
    const authorizations: Array<string | undefined> = [];
    yield* authorSyncCommand({
      root,
      apply: false,
      home,
      authState: Result.succeed({ source: "none" as const }),
    }).pipe(
      Effect.exit,
      Effect.provide(rendererTestLayer()),
      Effect.provide(
        registryHttpLayer(
          testHttpClientLayer((request) =>
            Effect.sync(() => {
              authorizations.push(request.headers.authorization);
              return Response.json({ error: "draft_not_found" }, { status: 404 });
            }),
          ),
        ),
      ),
      Effect.provide(
        skitConfigurationLayer().pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                SKIT_SERVER_URL: "https://environment.example",
                SKIT_TOKEN: "skit_pat_environment",
              }),
            ),
          ),
        ),
      ),
    );
    assert.isNotEmpty(authorizations);
    assert.isFalse(authorizations.some((header) => header?.includes("skit_pat_environment")));
  }).pipe(Effect.provide(testPlatformLayer)),
);
