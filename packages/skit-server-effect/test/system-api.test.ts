import { serverBuild } from "../src/build-info.js";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { systemHandlers } from "../src/api/system-http.js";
import { SkitApi } from "../src/api/system.js";
import { serverDiscovery } from "../src/discovery.js";

const handlers = Layer.mergeAll(systemHandlers, HttpServer.layerServices);
const makeClient = HttpApiTest.groups(SkitApi, ["system"]);

layer(handlers)("SystemApi", (it) => {
  it.effect("serves typed health and discovery contracts", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;

      expect(yield* client.system.health()).toEqual({
        schema: "skit.server.health.v1",
        status: "ok",
        build: serverBuild,
      });
      expect(yield* client.system.agentSkillsDiscovery()).toEqual(serverDiscovery);
      expect(yield* client.system.skitDiscovery()).toEqual(serverDiscovery);
    }),
  );
});
