import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem } from "effect";
import { NodeServices } from "@effect/platform-node";
import { join } from "node:path";
import { cliLayer } from "../src/application.js";
import { commandDescriptions } from "../src/commands/manifest.js";
import { runCommandTree } from "../src/commands/runtime.js";
import { skitCommand } from "../src/commands/tree.js";
import type { CommandFailure, CommandResult } from "../src/commands/types.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import { copySkitFixtureEffect } from "./helpers/library-home.js";

it.effect(
  "publishes every author command as experimental with help, outputs and inherited home",
  () =>
    commandDescriptions(skitCommand).pipe(
      Effect.map((commands) => {
        const author = commands.filter((command) => command.path[0] === "author");
        expect(author.map((command) => command.path[1])).toEqual([
          "init",
          "validate",
          "sync",
          "publish",
          "list",
          "delete",
          "invocation",
        ]);
        for (const command of author) {
          expect(command.stability).toBe("experimental");
          expect(command.summary).toMatch(/^Experimental:/);
          expect(command.flags).toHaveProperty("home");
          expect(command.outputSchemas.length).toBeGreaterThan(2);
        }
      }),
      Effect.provide(cliLayer(false, "/tmp/skit-author-command-help")),
    ),
);

it.effect(
  "executes author init, validation and invocation through the public grammar in an isolated home",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-commands-" });
      const home = join(root, "selected-home");
      const source = join(root, "source");
      yield* copySkitFixtureEffect("authored", source);
      const failures: CommandFailure[] = [];
      const results: CommandResult[] = [];
      const run = (args: readonly string[]) =>
        runCommandTree(skitCommand, [...args, "--json"], "test").pipe(
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
      yield* run(["author", "--home", home, "init", source]);
      expect(failures).toEqual([]);
      expect(results[0]).toMatchObject({
        contract: "init",
        data: { path: source, library_registration: "registered" },
      });
      expect(yield* fs.exists(join(home, "state.json"))).toBe(true);
      expect(yield* fs.exists(join(source, ".skit", "workspace.json"))).toBe(true);
      yield* run(["author", "validate", source, "--home", home]);
      expect(results[1]).toMatchObject({ contract: "validate", data: { valid: true } });
      const metadata = join(source, "skills", "review", "agents", "openai.yaml");
      const before = yield* fs.readFileString(metadata);
      yield* run(["author", "invocation", source, "--dry-run", "--home", home]);
      expect(results[2]).toMatchObject({
        contract: "authorInvocation",
        data: { path: source, dryRun: true },
      });
      expect(yield* fs.readFileString(metadata)).toBe(before);
      // Publication needs only workspace metadata, not a readable Library.
      yield* fs.writeFileString(join(home, "state.json"), "invalid Library must not be opened");
      yield* run(["author", "publish", source, "--version", "1.0.0", "--home", home]);
      expect(failures).toHaveLength(1);
      yield* run(["author", "list", "--registry", "https://registry.example.test", "--home", home]);
      expect(failures[1]).toMatchObject({ code: "AUTHENTICATION_REQUIRED", exitCode: 13 });
      yield* run([
        "author",
        "delete",
        "https://registry.example.test/me/tools",
        "--dry-run",
        "--home",
        home,
      ]);
      expect(failures[2]).toMatchObject({ code: "AUTHENTICATION_REQUIRED", exitCode: 13 });
      expect(failures[0].message).toMatch(/remote|sync/i);
      yield* run(["author", "validate", source, "--home", home]);
      expect(results[3]).toMatchObject({ contract: "validate", data: { valid: true } });
      expect(failures).toHaveLength(3);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    ),
);
