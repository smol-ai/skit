import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { Command } from "effect/cli";
import { SkitConfiguration, resolveSkitConfiguration } from "@smolai/skit-core";
import { runCommandTree } from "../src/commands/runtime.js";
import { rendererTestLayer } from "./helpers/renderer.js";

it.effect("standalone commands resolve configuration and preserve a supplied snapshot", () =>
  Effect.gen(function* () {
    const seen: string[] = [];
    const command = Command.make("probe", {}, () =>
      Effect.gen(function* () {
        const configuration = yield* SkitConfiguration;
        seen.push(configuration.stateHome);
      }),
    );
    const snapshot = yield* resolveSkitConfiguration();
    yield* runCommandTree(command, [], "0.0.0").pipe(
      Effect.provideService(SkitConfiguration, { ...snapshot, stateHome: "/supplied/state" }),
    );
    yield* runCommandTree(command, [], "0.0.0");
    expect(seen).toEqual(["/supplied/state", "/environment/state"]);
  }).pipe(
    Effect.provide(rendererTestLayer()),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_STATE_HOME: "/environment/state" })),
    ),
  ),
);
