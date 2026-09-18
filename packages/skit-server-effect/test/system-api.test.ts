import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/unstable/http";
import { HttpApiTest } from "effect/unstable/httpapi";
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
      });
      expect(yield* client.system.agentSkillsDiscovery()).toEqual(serverDiscovery);
      expect(yield* client.system.skitDiscovery()).toEqual(serverDiscovery);
    }),
  );
});
