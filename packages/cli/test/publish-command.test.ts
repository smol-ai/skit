import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Layer, Effect } from "effect";
import { HttpClient } from "effect/http";
import { MissingRequirement } from "../src/commands/input-failures.js";
import { publishCommand } from "../src/author/publish.js";
import { RegistryHttp, registryClient } from "../src/registry/registry-http.js";
import { rendererTestLayer } from "./helpers/renderer.js";

it.effect("requires an exact release version before reading the workspace", () =>
  publishCommand({}).pipe(
    Effect.provide(rendererTestLayer().pipe(Layer.provideMerge(testPlatformLayer))),
    Effect.provideService(
      RegistryHttp,
      RegistryHttp.of({
        client: Effect.succeed(registryClient(HttpClient.make(() => Effect.die("unreachable")))),
      }),
    ),
    Effect.flip,
    Effect.map((failure) =>
      assert.deepStrictEqual(
        failure,
        new MissingRequirement({ reason: { _tag: "PublishVersion" } }),
      ),
    ),
  ),
);
