import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import { deterministicTreeHashEffect, LibraryStore, skitLayer } from "@smolai/skit-core";
import { presentListCommand, shouldBrowseInteractively } from "../src/handlers/library/list.js";
import { browseLibraryEffect } from "../src/presentation/interactive-list.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { renderPortableLibraryList } from "../src/presentation/portable-library-list.js";
import { PortableListResult } from "../src/workflows/library/portable-list-contract.js";
import {
  confirmLibraryChange,
  openLibrarySession,
  proposeLibraryEnable,
} from "../src/workflows/library/session.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import {
  initializeLibraryMachine,
  libraryHome,
  retainObservedIn,
  writingTo,
} from "./helpers/library-home.js";
import type { CommandResult } from "../src/commands/types.js";
import { libraryCommandConfiguration } from "../src/commands/library-configuration.js";
import { presentPortableSetEnabled } from "../src/handlers/library/set-enabled.js";

it.effect("lists a retained Collection without Release-shaped fields", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-portable-commands-" });
    const home = yield* libraryHome({ home: join(root, "home") });
    yield* initializeLibraryMachine(home.home);
    const installed = join(root, "installed", "review");
    yield* fs.makeDirectory(installed, { recursive: true });
    yield* fs.writeFileString(join(installed, "SKILL.md"), "local Skill\n");
    const collection = yield* home.owned(
      writingTo(
        home.home,
        retainObservedIn(home.home)({
          identity: {
            profile: "declared-skit",
            version: 1,
            skitId: "tim/skills",
            authority: "https://skit.example.com",
          },
          input: installed,
          retainedAt: "2026-09-16T00:00:00.000Z",
          skills: [
            {
              name: "review",
              sourcePath: installed,
              relativePath: "review",
              observedHash: yield* deterministicTreeHashEffect(installed),
            },
          ],
          observations: [],
        }),
      ),
    );
    const rendered: CommandResult[] = [];
    yield* home.owned(
      presentListCommand().pipe(
        Effect.provide(
          rendererTestLayer({
            result: (value) =>
              Effect.sync(() => {
                rendered.push(value);
              }),
          }),
        ),
      ),
    );
    assert.strictEqual(rendered[0]?.schema, "skit.list.v2");
    const listing = yield* Schema.decodeUnknownEffect(PortableListResult)(rendered[0]?.data);
    assert.strictEqual(listing.collections[0]?.collection_id, collection.collection_id);
    assert.strictEqual(listing.collections[0]?.display_id, "tim/skills");
    assert.match(renderPortableLibraryList(listing), /^tim\/skills\n/);
    assert.deepStrictEqual(
      listing.collections[0]?.skills.map((skill) => skill.name),
      ["review"],
    );
    assert.deepStrictEqual(listing.bindings, []);
    assert.strictEqual(JSON.stringify(listing).includes("release"), false);

    const session = yield* home.owned(openLibrarySession(["codex"]));
    const row = session.skills[0];
    assert.ok(row);
    const proposed = yield* home.owned(
      proposeLibraryEnable(session, home.bindings, row, {
        harnesses: ["codex"],
        scope: { kind: "global" },
      }),
    );
    const beforeStaleChange = yield* home.durable;
    yield* home.owned(
      writingTo(
        home.home,
        LibraryStore.use((store) =>
          store.publish({
            ...beforeStaleChange,
            custodyIssues: beforeStaleChange.custodyIssues ?? [],
          }),
        ),
      ),
    );
    const stale = yield* home.owned(confirmLibraryChange(proposed, home.bindings));
    assert.strictEqual(stale.outcome?.kind, "failed");
    if (stale.outcome?.kind === "failed")
      assert.strictEqual(stale.outcome.failure.code, "CONFLICT");
    yield* home.owned(
      writingTo(
        home.home,
        LibraryStore.use((store) => store.publish(beforeStaleChange)),
      ),
    );

    const interaction = yield* makeScriptedInteraction(["Done"]);
    yield* home.owned(
      browseLibraryEffect(yield* home.owned(openLibrarySession([])), home.bindings).pipe(
        Effect.provide(interaction.layer),
      ),
    );
    assert.strictEqual((yield* interaction.prompts)[0]?.message, "Select a collection");
    assert.strictEqual(yield* interaction.remaining, 0);

    const unresolved = yield* home.owned(Effect.flatMap(LibraryStore, (store) => store.load));
    yield* home.owned(
      writingTo(
        home.home,
        LibraryStore.use((store) =>
          store.publish({
            ...unresolved,
            skills: unresolved.skills.map((skill, index) =>
              index === 0
                ? {
                    skill_id: skill.skill_id,
                    collection_id: skill.collection_id,
                    path: skill.path,
                    name: skill.name,
                    ...(skill.upstream_path === undefined
                      ? {}
                      : { upstream_path: skill.upstream_path }),
                    versions: skill.versions,
                  }
                : skill,
            ),
          }),
        ),
      ),
    );
    yield* home.owned(
      presentListCommand().pipe(
        Effect.provide(
          rendererTestLayer({
            result: (value) =>
              Effect.sync(() => {
                rendered.push(value);
              }),
          }),
        ),
      ),
    );
    const unresolvedListing = yield* Schema.decodeUnknownEffect(PortableListResult)(
      rendered[1]?.data,
    );
    assert.strictEqual(
      Object.hasOwn(unresolvedListing.collections[0]?.skills[0] ?? {}, "selected_skill_version_id"),
      false,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it("browses only on an attached human terminal", () => {
  assert.strictEqual(
    shouldBrowseInteractively({ json: false, stdin: true, stdout: true, stderr: true }),
    true,
  );
  assert.strictEqual(
    shouldBrowseInteractively({ json: true, stdin: true, stdout: true, stderr: true }),
    false,
  );
});

it.effect("offers only enabled Skills and identifies their Binding location", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-disable-choices-" });
    const home = yield* libraryHome({ home: join(root, "home") });
    yield* initializeLibraryMachine(home.home);
    const installed = join(root, "installed");
    const review = join(installed, "review");
    const effect = join(installed, "effect");
    for (const path of [review, effect]) yield* fs.makeDirectory(path, { recursive: true });
    yield* fs.writeFileString(join(review, "SKILL.md"), "review\n");
    yield* fs.writeFileString(join(effect, "SKILL.md"), "effect\n");
    const collection = yield* home.owned(
      writingTo(
        home.home,
        retainObservedIn(home.home)({
          identity: { profile: "local-collection", version: 1, path: installed },
          input: installed,
          retainedAt: "2026-09-17T00:00:00.000Z",
          skills: [
            {
              name: "review",
              sourcePath: review,
              relativePath: "review",
              observedHash: yield* deterministicTreeHashEffect(review),
            },
            {
              name: "effect",
              sourcePath: effect,
              relativePath: "effect",
              observedHash: yield* deterministicTreeHashEffect(effect),
            },
          ],
          observations: [],
        }),
      ),
    );
    const state = yield* home.durable;
    const reviewId = state.skills.find((skill) => skill.name === "review")?.skill_id;
    assert.ok(reviewId);
    yield* home.owned(
      writingTo(
        home.home,
        LibraryStore.use((store) =>
          store.publish({
            ...state,
            global_bindings: [
              {
                collection_id: collection.collection_id,
                harness: "codex",
                scope: { kind: "global" },
                skills: [reviewId],
              },
              {
                collection_id: collection.collection_id,
                harness: "claude-code",
                scope: { kind: "global" },
                skills: [reviewId],
              },
            ],
          }),
        ),
      ),
    );
    const configuration = yield* libraryCommandConfiguration({
      home: Option.some(home.home),
      codexRoot: Option.none(),
      claudeRoot: Option.none(),
      opencodeRoot: Option.none(),
      devinRoot: [],
    });
    const interaction = yield* makeScriptedInteraction([
      `all:${collection.collection_id}`,
      ["review"],
    ]);
    yield* home.owned(
      presentPortableSetEnabled({
        action: "disable",
        enabled: false,
        cwd: root,
        all: false,
        dryRun: false,
        interactive: true,
        configuration,
      }).pipe(Effect.provide(interaction.layer)),
    );
    const prompts = yield* interaction.prompts;
    assert.strictEqual(prompts.length, 2);
    assert.strictEqual(prompts[0]?.message, "Select where to disable Skills");
    assert.deepStrictEqual(prompts[0]?.choices[0], {
      value: `all:${collection.collection_id}`,
      label: `${collection.display_name} — everywhere enabled`,
      hint: "codex · global, claude-code · global",
    });
    assert.strictEqual(prompts[1]?.message, "Select Skills to disable");
    assert.deepStrictEqual(prompts[1]?.choices, [
      {
        value: "review",
        label: "review",
        hint: `${collection.display_name} · codex · global, ${collection.display_name} · claude-code · global`,
      },
    ]);
    assert.strictEqual((yield* interaction.results).length, 2);
    const disabled = yield* home.durable;
    assert.deepStrictEqual(disabled.global_bindings, []);
    assert.deepStrictEqual(disabled.local_bindings, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
