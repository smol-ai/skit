import { expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, FileSystem } from "effect";
import { NodeServices } from "@effect/platform-node";
import { Command } from "effect/cli";
import { SkitConfiguration, resolveSkitConfiguration } from "@smolai/skit-core/platform";
import { runCommandTree } from "../src/commands/runtime.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import { skitCommand } from "../src/commands/tree.js";
import type { CommandFailure } from "../src/commands/types.js";
import { join } from "node:path";

it.effect("an interrupted command propagates interruption without rendering a failure", () =>
  Effect.gen(function* () {
    const failures: CommandFailure[] = [];
    const command = Command.make("probe", {}, () => Effect.interrupt);
    const exit = yield* runCommandTree(command, [], "test").pipe(
      Effect.provide(
        rendererTestLayer({
          failure: (failure) =>
            Effect.sync(() => {
              failures.push(failure);
            }),
        }),
      ),
      Effect.exit,
    );
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(failures).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

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
    Effect.provide(NodeServices.layer),
    Effect.provide(rendererTestLayer()),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ XDG_STATE_HOME: "/environment/state" })),
    ),
  ),
);

it.effect("grouped commands inherit home before or after the child without opening Library", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-shared-home-" });
    const home = join(root, "selected");
    const ignored = join(root, "environment");
    yield* fs.makeDirectory(home);
    yield* fs.writeFileString(join(home, "state.json"), "invalid Library must not be opened");
    const failures: CommandFailure[] = [];
    const snapshot = yield* resolveSkitConfiguration(ignored);
    const run = (args: readonly string[]) =>
      runCommandTree(skitCommand, [...args, "--json"], "test").pipe(
        Effect.provideService(SkitConfiguration, snapshot),
        // An explicit application snapshot wins over later environment changes.
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ SKIT_HOME: join(root, "later") })),
        ),
        Effect.provide(
          rendererTestLayer({
            failure: (failure) =>
              Effect.sync(() => {
                failures.push(failure);
              }),
          }),
        ),
      );
    yield* run(["registry", "--home", home, "add", "first", "https://first.example"]);
    yield* run(["registry", "add", "second", "https://second.example", "--home", home]);
    yield* run(["repository", "--home", home, "watch", join(root, "repository")]);
    yield* run(["repository", "list", "--home", home]);
    yield* run(["auth", "--home", home, "status"]);
    expect(failures).toEqual([]);
    expect(
      JSON.parse(yield* fs.readFileString(join(home, "auth.json"))).registryAliases,
    ).toMatchObject({
      first: "https://first.example",
      second: "https://second.example",
    });
    expect(yield* fs.exists(join(home, "machine.json"))).toBe(true);
    expect(yield* fs.readFileString(join(home, "state.json"))).toBe(
      "invalid Library must not be opened",
    );
    expect(yield* fs.exists(ignored)).toBe(false);
    expect(yield* fs.exists(join(root, "later"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
