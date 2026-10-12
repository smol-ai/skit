import { sourceApplicationFromPaths } from "../src/application.js";
import { testPlatformLayer } from "./helpers/platform.js";
import { addRegistryRemoteEffect, readConfigEffect } from "../src/registry/auth.js";
import { resolveSkitPaths, skitPathsLayer, SkitPaths } from "../src/configuration/paths.js";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Fiber, FileSystem } from "effect";
import { join, resolve } from "node:path";
import { LibraryStore, withLibraryWriter } from "@smolai/skit-core";
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
        yield* addRegistryRemoteEffect("fixture", "https://registry.example.test", undefined).pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ SKIT_HOME: join(root, "ignored") })),
          ),
        );
        assert.isTrue(yield* fs.exists(join(home, "auth.json")));
      });
    yield* withConfigurationWriter(undefined, inside(configured)).pipe(
      Effect.provide(skitPathsLayer()),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ SKIT_HOME: configured }))),
    );
    yield* withConfigurationWriter(explicit, inside(explicit)).pipe(
      Effect.provide(skitPathsLayer(explicit)),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ SKIT_HOME: configured }))),
    );
    assert.isFalse(yield* fs.exists(join(configured, ".lock")));
    assert.isFalse(yield* fs.exists(join(explicit, ".lock")));
    assert.isFalse(yield* fs.exists(join(root, "ignored")));
    for (const home of [configured, explicit]) {
      const config = yield* readConfigEffect(home);
      assert.strictEqual(config.registryAliases?.fixture, "https://registry.example.test");
    }
  }).pipe(Effect.scoped, Effect.provide(testPlatformLayer)),
);

it.effect("path configuration separates account home, state root, and XDG roots", () =>
  Effect.gen(function* () {
    const paths = yield* resolveSkitPaths("relative-state", "/account").pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            SKIT_HOME: "/ignored",
            XDG_CONFIG_HOME: "/xdg/config",
            XDG_STATE_HOME: "/xdg/state",
          }),
        ),
      ),
    );
    assert.strictEqual(paths.userHome, "/account");
    assert.strictEqual(paths.skitHome, resolve("relative-state"));
    assert.strictEqual(paths.authPath, join(paths.skitHome, "auth.json"));
    assert.strictEqual(paths.configHome, "/xdg/config");
    assert.strictEqual(paths.stateHome, "/xdg/state");
    assert.strictEqual(paths.xdgStateHome, "/xdg/state");
    const defaults = yield* resolveSkitPaths(undefined, "/account").pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    );
    assert.strictEqual(defaults.skitHome, "/account/.skit");
    assert.strictEqual(defaults.configHome, "/account/.config");
    assert.strictEqual(defaults.stateHome, "/account/.local/state");
    assert.isUndefined(defaults.xdgStateHome);
    const empty = yield* resolveSkitPaths(undefined, "/account").pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ XDG_CONFIG_HOME: "", XDG_STATE_HOME: "" }),
        ),
      ),
    );
    assert.strictEqual(empty.configHome, defaults.configHome);
    assert.strictEqual(empty.stateHome, defaults.stateHome);
    assert.isUndefined(empty.xdgStateHome);
  }),
);

it.effect("parsed configuration commands honor ConfigProvider without a home flag", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-command-paths-" });
    const home = join(root, "configured");
    const failures: CommandFailure[] = [];
    yield* runCommandTree(
      skitCommand,
      ["registry", "add", "fixture", "https://registry.example.test", "--json"],
      "test",
    ).pipe(
      Effect.provide(
        rendererTestLayer({
          failure: (value) =>
            Effect.sync(() => {
              failures.push(value);
            }),
        }),
      ),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ SKIT_HOME: home }))),
    );
    assert.deepStrictEqual(failures, []);
    assert.isTrue(yield* fs.exists(join(home, "auth.json")));
    assert.isFalse(yield* fs.exists(join(home, "state.json")));
    assert.isFalse(yield* fs.exists(join(home, ".lock")));
  }).pipe(Effect.scoped, Effect.provide(testPlatformLayer)),
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
    }).pipe(Effect.scoped, Effect.provide(testPlatformLayer)),
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
  }).pipe(Effect.scoped, Effect.provide(testPlatformLayer)),
);

it.effect("application layers consume the supplied paths without re-reading configuration", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-paths-required-" });
    const paths = yield* resolveSkitPaths(join(root, "state"), join(root, "account")).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    );
    yield* Effect.gen(function* () {
      const store = yield* LibraryStore;
      const supplied = yield* SkitPaths;
      assert.strictEqual(store.home, paths.skitHome);
      assert.strictEqual(supplied.userHome, paths.userHome);
      yield* addRegistryRemoteEffect("fixture", "https://registry.example.test", undefined);
      assert.isTrue(yield* fs.exists(paths.authPath));
      assert.isFalse(yield* fs.exists(join(root, "ignored")));
    }).pipe(
      Effect.provide(sourceApplicationFromPaths),
      Effect.provideService(SkitPaths, paths),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ SKIT_HOME: join(root, "ignored") })),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(testPlatformLayer)),
);

it.effect("separate application boundaries retain their own storage roots", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-distinct-boundaries-" });
    const homes = [join(root, "first"), join(root, "second")];
    const resolved = yield* Effect.forEach(homes, (home) =>
      Effect.gen(function* () {
        const store = yield* LibraryStore;
        const paths = yield* SkitPaths;
        assert.strictEqual(store.home, paths.skitHome);
        return store.home;
      }).pipe(Effect.provide(libraryApplicationLayer(home))),
    );
    assert.deepStrictEqual(resolved, homes);
  }).pipe(Effect.scoped, Effect.provide(testPlatformLayer)),
);
