import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HealthResponse, inspectHealth } from "../src/health.js";

describe("Health", () => {
  it.effect("reports the versioned liveness contract", () =>
    Effect.gen(function* () {
      const health = yield* inspectHealth();
      const encoded = yield* Schema.encodeEffect(HealthResponse)(health);

      expect(encoded).toEqual({
        schema: "skit.server.health.v1",
        status: "ok",
      });
    }),
  );
});
