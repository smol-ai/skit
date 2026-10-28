import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { detectInstalledHarnesses } from "../src/harness/catalog.js";
import { testPlatformLayer } from "./helpers/platform.js";

const emptyHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-harnesses-" });
  return { home, configHome: join(home, ".config") };
});

describe("harness probing", () => {
  it.effect("detects supported harnesses from their filesystem markers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { home, configHome } = yield* emptyHome;
      for (const marker of [
        join(home, ".codex"),
        join(home, ".claude"),
        join(configHome, "opencode"),
        join(configHome, "devin"),
      ])
        yield* fs.makeDirectory(marker, { recursive: true });
      expect(yield* detectInstalledHarnesses({ home, configHome })).toEqual([
        "codex",
        "claude-code",
        "opencode",
        "devin",
      ]);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );

  it.effect("treats explicit skills directories as installed harnesses", () =>
    Effect.gen(function* () {
      const { home, configHome } = yield* emptyHome;
      expect(
        yield* detectInstalledHarnesses({ home, configHome, overrides: { codex: ["/codex"] } }),
      ).toEqual(["codex"]);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );

  it.effect("does not infer Devin availability from repository install support", () =>
    Effect.gen(function* () {
      const { home, configHome } = yield* emptyHome;
      expect(yield* detectInstalledHarnesses({ home, configHome })).toEqual([]);
      expect(
        yield* detectInstalledHarnesses({
          home,
          configHome,
          overrides: { devin: ["/repo/.devin/skills"] },
        }),
      ).toEqual([]);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );
});
