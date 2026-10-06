import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import { deterministicTreeHashEffect, LibraryStore, skitLayer } from "@smolai/skit-core";
import { presentListCommand, shouldBrowseInteractively } from "../src/handlers/library/list.js";
import { browseLibraryEffect } from "../src/presentation/interactive-list.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { renderLibraryList } from "../src/presentation/library-list.js";
import { ListResult } from "../src/workflows/library/list-contract.js";
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
import { presentSetEnabled } from "../src/handlers/library/set-enabled.js";

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
          source: {
            type: "registry",
            namespace: "tim",
            slug: "skills",
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
    assert.strictEqual(rendered[0]?.schema, "skit.list.v6");
    const listing = yield* Schema.decodeUnknownEffect(ListResult)(rendered[0]?.data);
    assert.strictEqual(listing.subjects[0]?.subject_id, collection.collection?.collection_id);
    assert.strictEqual(listing.subjects[0]?.label, "tim/skills");
    assert.match(renderLibraryList(listing), /^tim\/skills\n/);
    assert.deepStrictEqual(
      listing.subjects[0]?.skills.map((skill) => skill.name),
      ["review"],
    );
    assert.deepStrictEqual(listing.bindings, []);
    assert.strictEqual(JSON.stringify(listing).includes("release"), false);

    const session = yield* home.owned(openLibrarySession());
    const row = session.skills[0];
    assert.ok(row);
    const proposed = yield* home.owned(
      proposeLibraryEnable(session, home.bindings, row, { scope: { kind: "global" } }),
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
      browseLibraryEffect(yield* home.owned(openLibrarySession()), home.bindings).pipe(
        Effect.provide(interaction.layer),
      ),
    );
    assert.strictEqual((yield* interaction.prompts)[0]?.message, "Select a collection");
    assert.strictEqual(yield* interaction.remaining, 0);
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
          source: { type: "local", path: installed },
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
              { scope: { kind: "global" }, entries: [{ kind: "skill", skill_id: reviewId }] },
            ],
            local_bindings: [
              {
                scope: { kind: "repository", root },
                entries: [{ kind: "skill", skill_id: reviewId }],
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
      `all:${collection.collection?.collection_id}`,
      "skills",
      ["review"],
    ]);
    yield* home.owned(
      presentSetEnabled({
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
    assert.strictEqual(prompts.length, 3);
    assert.strictEqual(prompts[0]?.message, "Select where to disable Skills");
    assert.deepStrictEqual(prompts[0]?.choices[0], {
      value: `all:${collection.collection?.collection_id}`,
      label: `${collection.collection?.label} — everywhere enabled`,
      hint: `global, repository ${root}`,
    });
    assert.strictEqual(prompts[2]?.message, "Select Skills to disable");
    assert.deepStrictEqual(prompts[2]?.choices, [
      {
        value: "review",
        label: "review",
        hint: `${collection.collection?.label} · global, ${collection.collection?.label} · repository ${root}`,
      },
    ]);
    assert.strictEqual((yield* interaction.results).length, 2);
    const disabled = yield* home.durable;
    assert.deepStrictEqual(disabled.global_bindings, []);
    assert.deepStrictEqual(disabled.local_bindings, []);
    const collectionId = collection.collection!.collection_id;
    const enable = yield* makeScriptedInteraction([collectionId, "collection"]);
    yield* home.owned(
      presentSetEnabled({
        action: "enable",
        enabled: true,
        cwd: root,
        all: false,
        dryRun: false,
        interactive: true,
        scope: { kind: "global" },
        configuration,
      }).pipe(Effect.provide(enable.layer)),
    );
    assert.deepStrictEqual((yield* home.durable).global_bindings[0]?.entries, [
      { kind: "collection", collection_id: collectionId },
    ]);
    assert.ok(!(yield* enable.prompts).some((prompt) => prompt.kind === "multiselect"));

    const unchangedBrowse = yield* makeScriptedInteraction([
      collectionId,
      "Enable whole collection",
      "global",
      "Back to collections",
      "Done",
    ]);
    yield* home.owned(
      browseLibraryEffect(yield* home.owned(openLibrarySession()), {
        ...home.bindings,
        ...configuration.inventory,
      }).pipe(Effect.provide(unchangedBrowse.layer)),
    );
    assert.ok(!(yield* unchangedBrowse.prompts).some((prompt) => prompt.kind === "confirm"));
    assert.ok((yield* unchangedBrowse.notes).some((note) => note.title === "No change"));
    const beforeCancel = yield* home.durable;
    yield* home.owned(
      presentSetEnabled({
        action: "disable",
        enabled: false,
        subject: collectionId,
        cwd: root,
        all: false,
        dryRun: false,
        interactive: true,
        scope: { kind: "global" },
        configuration,
      }).pipe(Effect.provide((yield* makeScriptedInteraction(["cancel"])).layer)),
    );
    assert.deepStrictEqual(yield* home.durable, beforeCancel);

    const browseCancel = yield* makeScriptedInteraction([
      collectionId,
      "Disable whole collection",
      false,
      "Back to collections",
      "Done",
    ]);
    yield* home.owned(
      browseLibraryEffect(yield* home.owned(openLibrarySession()), home.bindings).pipe(
        Effect.provide(browseCancel.layer),
      ),
    );
    assert.deepStrictEqual(yield* home.durable, beforeCancel);
    const browseDisable = yield* makeScriptedInteraction([
      collectionId,
      "Disable whole collection",
      true,
      "Back to collections",
      "Done",
    ]);
    yield* home.owned(
      browseLibraryEffect(yield* home.owned(openLibrarySession()), home.bindings).pipe(
        Effect.provide(browseDisable.layer),
      ),
    );
    assert.deepStrictEqual((yield* home.durable).global_bindings, []);
    yield* home.owned(
      presentSetEnabled({
        action: "enable",
        enabled: true,
        subject: collectionId,
        cwd: root,
        all: true,
        dryRun: false,
        interactive: false,
        scope: { kind: "repository", root },
        configuration,
      }).pipe(Effect.provide((yield* makeScriptedInteraction([])).layer)),
    );
    const directDisable = yield* makeScriptedInteraction(["collection"]);
    yield* home.owned(
      presentSetEnabled({
        action: "disable",
        enabled: false,
        subject: collectionId,
        cwd: home.home,
        all: false,
        dryRun: false,
        interactive: true,
        configuration,
      }).pipe(Effect.provide(directDisable.layer)),
    );
    assert.deepStrictEqual((yield* home.durable).local_bindings, []);
    assert.strictEqual(yield* directDisable.remaining, 0);
    assert.strictEqual((yield* directDisable.prompts).length, 1);
    for (const scope of [{ kind: "global" } as const, { kind: "repository", root } as const]) {
      yield* home.owned(
        presentSetEnabled({
          action: "enable",
          enabled: true,
          subject: collectionId,
          cwd: root,
          all: true,
          dryRun: false,
          interactive: false,
          scope,
          configuration,
        }).pipe(Effect.provide((yield* makeScriptedInteraction([])).layer)),
      );
    }
    const disableEverywhere = yield* makeScriptedInteraction(["collection", "all"]);
    yield* home.owned(
      presentSetEnabled({
        action: "disable",
        subject: collectionId,
        enabled: false,
        cwd: root,
        all: false,
        dryRun: false,
        interactive: true,
        configuration,
      }).pipe(Effect.provide(disableEverywhere.layer)),
    );
    assert.deepStrictEqual((yield* home.durable).global_bindings, []);
    assert.deepStrictEqual((yield* home.durable).local_bindings, []);
    assert.strictEqual(yield* disableEverywhere.remaining, 0);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("bare disable asks before changing a global Binding spanning Collections", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-disable-single-" });
    const home = yield* libraryHome({ home: join(root, "home") });
    yield* initializeLibraryMachine(home.home);
    const source = join(root, "show-me");
    yield* fs.makeDirectory(source);
    yield* fs.writeFileString(join(source, "SKILL.md"), "Show the current topic visually.\n");
    yield* home.owned(
      writingTo(
        home.home,
        retainObservedIn(home.home)({
          source: { type: "local", path: source },
          input: source,
          retainedAt: "2026-10-06T00:00:00.000Z",
          skills: [
            {
              name: "show-me",
              sourcePath: source,
              relativePath: ".",
              observedHash: yield* deterministicTreeHashEffect(source),
            },
          ],
          observations: [],
        }),
      ),
    );
    const other = join(root, "effect");
    yield* fs.makeDirectory(other);
    yield* fs.writeFileString(join(other, "SKILL.md"), "Effect reference.\n");
    yield* home.owned(
      writingTo(
        home.home,
        retainObservedIn(home.home)({
          source: { type: "local", path: other },
          input: other,
          retainedAt: "2026-10-06T00:00:00.000Z",
          skills: [
            {
              name: "effect",
              sourcePath: other,
              relativePath: ".",
              observedHash: yield* deterministicTreeHashEffect(other),
            },
          ],
          observations: [],
        }),
      ),
    );
    const retained = yield* home.durable;
    const state = {
      ...retained,
      global_bindings: [
        {
          scope: { kind: "global" as const },
          entries: retained.skills.map((skill) => ({
            kind: "skill" as const,
            skill_id: skill.skill_id,
          })),
        },
      ],
    };
    yield* home.owned(LibraryStore.use((store) => store.publish(state)));
    const configuration = yield* libraryCommandConfiguration({
      home: Option.some(home.home),
      codexRoot: Option.none(),
      claudeRoot: Option.none(),
      opencodeRoot: Option.none(),
      devinRoot: [],
    });
    const interaction = yield* makeScriptedInteraction(["cancel"]);
    yield* home.owned(
      presentSetEnabled({
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
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0]?.message, "Select where to disable Skills");
    assert.ok(prompts[0]?.choices.some((choice) => choice.hint?.includes("show-me")));
    assert.deepStrictEqual(yield* home.durable, state);
    assert.strictEqual((yield* interaction.results).length, 0);
    assert.strictEqual(prompts[0]?.choices.length, 2);
    const effectChoice = prompts[0]?.choices.find((choice) => choice.hint === "effect");
    assert.ok(effectChoice);
    const selection = yield* makeScriptedInteraction([effectChoice.value, "skills", ["effect"]]);
    yield* home.owned(
      presentSetEnabled({
        action: "disable",
        enabled: false,
        cwd: root,
        all: false,
        dryRun: false,
        interactive: true,
        configuration,
      }).pipe(Effect.provide(selection.layer)),
    );
    const after = yield* home.durable;
    const showMe = retained.skills.find((skill) => skill.name === "show-me");
    assert.ok(showMe);
    assert.deepStrictEqual(after.global_bindings[0]?.entries, [
      { kind: "skill", skill_id: showMe.skill_id },
    ]);
    const single = yield* makeScriptedInteraction(["cancel"]);
    yield* home.owned(
      presentSetEnabled({
        action: "disable",
        enabled: false,
        cwd: root,
        all: false,
        dryRun: false,
        interactive: true,
        configuration,
      }).pipe(Effect.provide(single.layer)),
    );
    assert.strictEqual((yield* single.prompts).length, 1);
    assert.deepStrictEqual(yield* home.durable, after);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
