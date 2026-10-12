import { assert, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Fiber, FileSystem } from "effect";
import { join } from "node:path";
import { LibraryStore, skitLayer, withLibraryWriter } from "@smolai/skit-core";
import { libraryApplicationLayer } from "../src/library-application/layers.js";
import { skitCommand } from "../src/commands/tree.js";
import { runCommandTree } from "../src/commands/runtime.js";
import type { CommandFailure, CommandResult } from "../src/commands/types.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import { withConfigurationWriter } from "../src/configuration-writer.js";

it.effect("configuration writers honor ConfigProvider and explicit home overrides", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-config-provider-" });
    const configured = join(root, "configured");
    const explicit = join(root, "explicit");
    const inside = (home: string) =>
      Effect.gen(function* () {
        assert.isTrue(yield* fs.exists(join(home, ".lock")));
        assert.isFalse(yield* fs.exists(join(home, "state.json")));
      });
    yield* withConfigurationWriter(undefined, inside(configured)).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ SKIT_HOME: configured }))),
    );
    yield* withConfigurationWriter(explicit, inside(explicit)).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ SKIT_HOME: configured }))),
    );
    assert.isFalse(yield* fs.exists(join(configured, ".lock")));
    assert.isFalse(yield* fs.exists(join(explicit, ".lock")));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "listing current Library state remains available while another workflow holds the writer",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-read-during-write-" });
      const ready = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* withLibraryWriter(
        Effect.gen(function* () {
          const store = yield* LibraryStore;
          yield* store.publish(yield* store.load);
          yield* Deferred.succeed(ready, undefined);
          yield* Deferred.await(release);
        }),
      ).pipe(Effect.provide(libraryApplicationLayer(home)), Effect.forkScoped);
      yield* Deferred.await(ready);
      const results: CommandResult[] = [];
      const failures: CommandFailure[] = [];
      yield* runCommandTree(skitCommand, ["list", "--json", "--home", home], "test").pipe(
        Effect.provide(
          rendererTestLayer({
            result: (value) =>
              Effect.sync(() => {
                results.push(value);
              }),
            failure: (value) =>
              Effect.sync(() => {
                failures.push(value);
              }),
          }),
        ),
      );
      assert.deepStrictEqual(failures, []);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]?.schema, "skit.list.v6");
      assert.isTrue(yield* fs.exists(join(home, ".lock")));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      assert.isFalse(yield* fs.exists(join(home, ".lock")));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("Registry configuration commands do not open or create Library storage", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-registry-without-library-" });
    const home = join(root, "home");
    const results: CommandResult[] = [];
    const failures: CommandFailure[] = [];
    const run = (args: readonly string[]) =>
      runCommandTree(skitCommand, [...args, "--json", "--home", home], "test").pipe(
        Effect.provide(
          rendererTestLayer({
            result: (value) =>
              Effect.sync(() => {
                results.push(value);
              }),
            failure: (value) =>
              Effect.sync(() => {
                failures.push(value);
              }),
          }),
        ),
      );
    yield* run(["registry", "list"]);
    assert.isFalse(yield* fs.exists(home));
    yield* fs.makeDirectory(home);
    yield* fs.writeFileString(join(home, "state.json"), "invalid Library state");
    yield* run(["registry", "add", "fixture", "https://registry.example.test"]);
    yield* run(["registry", "list"]);
    assert.deepStrictEqual(failures, []);
    assert.strictEqual(results.length, 3);
    assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), "invalid Library state");
    assert.isFalse(yield* fs.exists(join(home, ".lock")));
    assert.isFalse(yield* fs.exists(join(home, "audit.jsonl")));
    // Configuration writes retain the existing storage exclusion, without state snapshots.
    yield* fs.writeFileString(join(home, ".lock"), `${process.pid}\n`);
    yield* run(["registry", "add", "contended", "https://other.example.test"]);
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0]?.code, "CONFLICT");
    yield* run(["registry", "list"]);
    assert.strictEqual(failures.length, 1);
    assert.isTrue(yield* fs.exists(join(home, ".lock")));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
