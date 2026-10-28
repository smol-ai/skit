import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { assert, it } from "@effect/vitest";
import { skitLayer } from "@smolai/skit-core";
import { runSetup } from "../src/workflows/library/setup.js";
import { libraryHome, scratch } from "./helpers/library-home.js";

it.effect("suggests common folders holding repositories only while none is configured", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* scratch("skit-setup-suggestions-"));
    yield* fs.makeDirectory(join(root, "Work", "app", ".git"), { recursive: true });
    yield* fs.makeDirectory(join(root, "dev", "notes"), { recursive: true });
    const home = yield* libraryHome({ home: join(root, "library"), inventoryHome: root });
    const scan = (repositoryRoots: readonly string[]) =>
      home.owned(
        runSetup({
          libraryHome: home.home,
          inventory: home.inventory,
          probePath: "",
          skillsStateHome: join(root, "state"),
          repositoryRoots,
          persistRoots: false,
        }),
      );

    assert.deepStrictEqual((yield* scan([])).suggestedRepositoryRoots, [join(root, "Work")]);
    assert.deepStrictEqual((yield* scan([join(root, "Work")])).suggestedRepositoryRoots, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
