import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { skitLayer } from "@smolai/skit-core";
import { detectInstalledHarnesses } from "../src/harness/catalog.js";
import { SkitConfiguration, resolveSkitConfiguration } from "@smolai/skit-core";

it.effect("CLI detection supplies omitted roots from the application configuration", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-cli-harness-defaults-" });
    yield* fs.makeDirectory(join(home, ".codex"));
    const paths = yield* resolveSkitConfiguration(join(home, "skit"), home);
    const detected = yield* detectInstalledHarnesses().pipe(
      Effect.provideService(SkitConfiguration, { ...paths, configHome: join(home, "config") }),
    );
    expect(detected).toEqual(["codex"]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
