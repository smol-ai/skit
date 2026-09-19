import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skitLayer } from "../src/platform/layer.js";
import { inspectLibrary } from "./helpers/library-store.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "library-state");

it.effect("migrates a persisted v4 well-known subset once at the state-file boundary", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-v4-migration-" });
    const fixture = yield* fs.readFileString(join(fixtures, "v4-well-known-subset.json"));
    yield* fs.writeFileString(join(home, "state.json"), fixture);

    const migrated = yield* inspectLibrary(home);
    assert.strictEqual(migrated.present, true);
    if (!migrated.present) return;
    assert.strictEqual(migrated.state.schemaVersion, 5);
    assert.strictEqual(migrated.state.collections.length, 0);
    assert.deepStrictEqual(migrated.state.acquisitions[0]?.selection, {
      kind: "selected-skills",
      names: ["review"],
    });
    assert.strictEqual(
      migrated.state.acquisitions[0]?.input.value,
      "wellknown:https://skills.example",
    );
    assert.deepStrictEqual(migrated.state.skills[0]?.upstream?.selection, {
      kind: "selected-skills",
      names: ["review"],
    });

    const reopened = yield* inspectLibrary(home);
    assert.strictEqual(reopened.present, true);
    if (!reopened.present) return;
    assert.deepStrictEqual(reopened.state, migrated.state);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
