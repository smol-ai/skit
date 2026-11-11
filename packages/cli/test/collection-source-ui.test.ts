import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { join } from "node:path";
import * as Library from "@smolai/skit-core/library";
import { authorLayer, initializeAuthorWorkspace } from "@smolai/skit-core/author";
import { skitLayer } from "@smolai/skit-core/platform";
import { runCommandTree } from "../src/commands/runtime.js";
import { skitCommand } from "../src/commands/tree.js";
import type { CommandFailure, CommandResult } from "../src/commands/types.js";
import { renderResultFrame, defaultTerminalEnvironment } from "../src/commands/output-frame.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import { presentContract } from "../src/commands/output-presenters.js";
import { Block } from "../src/terminal/blocks.js";
import { browseLibrary } from "../src/library/list/browse.js";
import { Prompter, PromptCancelled, type Choice } from "../src/terminal/prompter.js";
import { result } from "../src/commands/result.js";
import { presentSetEnabled } from "../src/library/enable.js";

it.effect(
  "CLI list, source choices, enable and removal previews identify a workspace separately from a same-named release",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-source-ui-" }),
      );
      const workspace = join(directory, "skills");
      const home = join(directory, "home");
      const agents = join(directory, "installed");
      yield* fs.makeDirectory(join(workspace, "skills/review"), { recursive: true });
      yield* fs.writeFileString(
        join(workspace, "skills/review/SKILL.md"),
        "---\nname: review\ndescription: Review code\n---\nReview.\n",
      );
      yield* fs.writeFileString(
        join(workspace, "skit.json"),
        JSON.stringify({ slug: "skills", skills: [{ name: "review", path: "skills/review" }] }),
      );
      const roots = {
        home: directory,
        configHome: join(directory, "config"),
        overrides: { codex: [agents] },
      };
      const owner = Library.layer({ home, roots }).pipe(Layer.provideMerge(authorLayer({ home })));
      yield* Effect.gen(function* () {
        yield* initializeAuthorWorkspace(workspace, home);
        yield* fs.writeFileString(
          join(workspace, "skit.remote.json"),
          JSON.stringify({
            schema: "skit.remote.v1",
            origin: "https://registry.example",
            namespace: "tim",
            skit: "skills",
          }),
        );
        const library = yield* Library.Service;
        yield* library.import.authored({
          root: workspace,
          input: "skit://registry.example/tim/skills",
          label: "tim/skills",
          source: {
            type: "registry",
            authority: "https://registry.example",
            namespace: "tim",
            slug: "skills",
          },
          importedAt: "2026-11-09T00:00:00Z",
        });
        let choices: readonly Choice<string>[] = [];
        const stop = (prompt: string) =>
          Effect.fail(new PromptCancelled({ prompt, reason: "back" }));
        yield* browseLibrary(yield* library.session.open()).pipe(
          Effect.provideService(
            Prompter,
            Prompter.of({
              autocomplete: (prompt, items) => {
                choices = items;
                return stop(prompt);
              },
              select: stop,
              multiselect: stop,
              confirm: stop,
              text: stop,
              password: stop,
            }),
          ),
          Effect.provide(rendererTestLayer()),
        );
        assert.isTrue(
          choices.some(
            (choice) =>
              choice.label.startsWith("tim/skills (Author workspace:") &&
              choice.label.includes(workspace),
          ),
        );
        yield* presentSetEnabled({
          action: "enable",
          enabled: true,
          cwd: directory,
          all: false,
          dryRun: true,
          interactive: true,
        }).pipe(
          Effect.provideService(
            Prompter,
            Prompter.of({
              autocomplete: (prompt, items) => {
                choices = items;
                return stop(prompt);
              },
              select: stop,
              multiselect: stop,
              confirm: stop,
              text: stop,
              password: stop,
            }),
          ),
          Effect.provide(rendererTestLayer()),
        );
        assert.isTrue(
          choices.some(
            (choice) =>
              choice.label.includes("Author workspace") && choice.label.includes(workspace),
          ),
        );
        assert.isTrue(
          choices.some(
            (choice) =>
              choice.label.includes("Registry release") &&
              choice.label.includes("https://registry.example"),
          ),
        );
        assert.isTrue(
          choices.some(
            (choice) =>
              choice.label.startsWith("tim/skills (Registry release:") &&
              choice.label.includes("https://registry.example"),
          ),
        );
      }).pipe(Effect.provide(owner));

      const results: CommandResult[] = [];
      const failures: CommandFailure[] = [];
      const run = (args: readonly string[]) =>
        runCommandTree(skitCommand, [...args, "--home", home, "--json"], "test").pipe(
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
      const rendered = () => renderResultFrame(results.at(-1)!, defaultTerminalEnvironment).stdout;
      yield* run(["list"]);
      assert.include(rendered(), "tim/skills (Author workspace)");
      assert.include(rendered(), workspace);
      assert.include(rendered(), "tim/skills (Registry release)");
      assert.include(rendered(), "Disabled");
      assert.notInclude(rendered(), "authored:workspace_");
      const before = yield* fs.readFileString(join(home, "state.json"));
      yield* run(["enable", workspace, "--all", "--global", "--dry-run", "--codex-root", agents]);
      const presented = () => {
        const output = presentContract(results.at(-1)!, { color: false, detail: "summary" });
        return typeof output === "string" ? [] : output;
      };
      assert.deepInclude(presented(), Block.Heading({ text: "tim/skills (Author workspace)" }));
      assert.deepInclude(
        presented(),
        Block.Changes({ items: [{ action: "add", label: "Would enable review" }] }),
      );
      yield* run(["remove", workspace, "--dry-run"]);
      assert.deepInclude(presented(), Block.Heading({ text: "tim/skills (Author workspace)" }));
      assert.deepInclude(
        presented(),
        Block.Note({
          text: [
            "Removes the Library registration and installed copies. Authored files and the Registry connection remain in the workspace.",
          ],
        }),
      );
      yield* run(["remove", "https://registry.example/tim/skills", "--dry-run"]);
      assert.deepInclude(presented(), Block.Heading({ text: "tim/skills (Registry release)" }));
      assert.deepInclude(
        presented(),
        Block.Note({
          text: [
            "Removes this release from the Library; the published release stays in the Registry.",
          ],
        }),
      );
      assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), before);
      assert.isFalse(yield* fs.exists(agents));
      assert.deepStrictEqual(failures, []);
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "watch output explains source mismatch and offers a readable, shell-safe workspace command",
  () =>
    Effect.sync(() => {
      const path = "/tmp/Tim's skills";
      const frame = renderResultFrame(
        result("authorWatch", {
          event: "installation",
          reason: "startup",
          installed_copies: [],
          path,
          status: "unchanged",
          installed: 0,
          issues: [],
          context: {
            collection_label: "skills",
            total: 1,
            disabled_skills: ["review"],
            source: {
              kind: "authored-workspace",
              name: "tim/skills",
              locator: path,
              authority: "https://registry.example",
              workspace_status: "connected",
            },
            other_sources: [
              {
                skill: "review",
                path: "/tmp/installed/review",
                collection_label: "tim/skills",
                source: {
                  kind: "registry",
                  name: "tim/skills",
                  locator: "skit://registry.example/tim/skills",
                  authority: "https://registry.example",
                },
              },
            ],
          },
        }),
        defaultTerminalEnvironment,
      );
      assert.include(frame.stdout, "tim/skills (Author workspace)");
      assert.include(frame.stdout, "saved but disabled");
      assert.include(frame.stdout, "follows tim/skills (Registry release)");
      assert.include(frame.stdout, "skit enable '/tmp/Tim'\\''s skills' --all --global");
    }),
);
