import { assert, it } from "@effect/vitest";
import { LibraryStore, skitLayer } from "@smolai/skit-core";
import { Effect, Result } from "effect";
import { HttpClient } from "effect/unstable/http";
import { authorSyncCommand } from "../src/handlers/author/sync.js";
import { librarySyncCommand } from "../src/handlers/library/sync.js";
import { CredentialsUnusable } from "../src/registry/failures.js";
import { RegistryHttp, registryClient } from "../src/registry/registry-http.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import { MissingRequirement } from "../src/handlers/failures.js";

const failure = new CredentialsUnusable({ path: "/broken/auth.json", reason: "invalid" });

const services = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(rendererTestLayer()),
    Effect.provide(skitLayer),
    Effect.provideService(
      LibraryStore,
      LibraryStore.of({
        load: Effect.die("unreachable"),
        inspect: Effect.die("unreachable"),
        publish: () => Effect.die("unreachable"),
        snapshot: Effect.succeed(undefined),
        recordChangesSince: () => Effect.void,
        home: "/unreachable",
        originalsPath: "/unreachable/originals",
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
      projection: { variantsPath: "/unused/variants", rootFor: () => undefined },
    }),
  ).pipe(
    Effect.flip,
    Effect.map((actual) => assert.strictEqual(actual, failure)),
  ),
);
