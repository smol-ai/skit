import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { checkSetupGlobalContent } from "../src/library/internal/setup/protection.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect("physical ancestors of a configured root alias retain their ownership veto", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "skit-protected-alias-" }),
    );
    const physical = join(root, "checkout", "nested", "skills");
    yield* fs.makeDirectory(physical, { recursive: true });
    const alias = join(root, "alias");
    yield* fs.symlink(physical, alias);
    const destination = join(alias, "absent-skill");
    yield* checkSetupGlobalContent(destination);
    yield* fs.writeFileString(join(root, "checkout", ".git"), "gitdir: elsewhere");
    expect((yield* Effect.result(checkSetupGlobalContent(destination)))._tag).toBe("Failure");
    expect(yield* fs.exists(destination)).toBe(false);
    expect(yield* fs.readLink(alias)).toBe(physical);
  }).pipe(Effect.provide(skitLayer)),
);
