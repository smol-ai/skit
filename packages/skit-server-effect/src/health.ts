import { BuildInfo } from "@smolai/skit-core/universal/consumer";
import { serverBuild } from "./build-info.js";
import { Effect, Schema } from "effect";

export const HealthResponse = Schema.Struct({
  schema: Schema.Literal("skit.server.health.v1"),
  status: Schema.Literal("ok"),
  build: BuildInfo,
});

export interface HealthResponse extends Schema.Schema.Type<typeof HealthResponse> {}

export const inspectHealth = Effect.fn("Health.inspect")(() =>
  Effect.succeed(
    HealthResponse.make({ schema: "skit.server.health.v1", status: "ok", build: serverBuild }),
  ),
);
