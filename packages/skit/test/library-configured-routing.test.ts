import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { InstalledSkills } from "../src/library/installed-skills.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect(
  "configured InstalledSkills owns global and repository routing without CLI configuration",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-configured-routing-" });
      const agents = join(home, "agents");
      const claude = join(home, "claude");
      const overrides = { codex: [agents], "claude-code": [claude] };
      const skills = yield* InstalledSkills.make({
        home,
        configHome: join(home, "config"),
        overrides,
      });
      const redirected = join(home, "redirected");
      overrides.codex[0] = redirected;
      assert.deepStrictEqual(yield* skills.active, ["agents", "claude"]);
      assert.deepStrictEqual(yield* skills.destinations({ kind: "global" }), [
        { destination: "agents", root: agents },
        { destination: "claude", root: claude },
      ]);
      const repository = join(home, "repository");
      assert.deepStrictEqual(yield* skills.destinations({ kind: "repository", root: repository }), [
        { destination: "agents", root: join(repository, ".agents", "skills") },
        { destination: "claude", root: join(repository, ".claude", "skills") },
      ]);
      const scanned = yield* skills.duplicates.scan({ kind: "global" }, []);
      assert.isTrue(scanned.roots.includes(agents));
      assert.isFalse(scanned.roots.includes(redirected));
      assert.deepStrictEqual(yield* fs.readDirectory(home), []);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
