import { assert, it } from "@effect/vitest";
import { skitLayer } from "@smolai/skit-core";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import { MissingRequirement } from "../src/handlers/failures.js";
import { publishCommand } from "../src/handlers/author/publish.js";
import { RegistryHttp, registryClient } from "../src/registry/registry-http.js";
import { rendererTestLayer } from "./helpers/renderer.js";

it.effect("requires an exact release version before reading the workspace", () =>
  publishCommand({}).pipe(
    Effect.provide(rendererTestLayer()),
    Effect.provide(skitLayer),
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
        new MissingRequirement({ command: "publish", requires: "--version" }),
      ),
    ),
  ),
);
