import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import {
  deterministicTreeHashEffect,
  LibraryStore,
  libraryStoreLayer,
  projectBindingEffect,
  skitLayer,
} from "@smolai/skit-core";
import { isolatedRoots } from "./helpers/isolated-library.js";
import { executePinEffect } from "../src/workflows/library/pin.js";
import { addLibrarySourceEffect } from "../src/workflows/library/add.js";
import {
  archiveBytes,
  copySkitFixtureEffect,
  initializeLibraryMachine,
  libraryHome,
  retainObservedIn,
  writingTo,
} from "./helpers/library-home.js";

it.effect("selects a retained Version and retries Projection without acquiring a Release", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-pin-" });
    const roots = isolatedRoots(workspace);
    const home = roots.home;
    const source = join(workspace, "raw-review");
    yield* initializeLibraryMachine(home);
    yield* fs.makeDirectory(source, { recursive: true });
    const observe = (text: string) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(join(source, "SKILL.md"), text);
        return yield* Effect.scoped(
          writingTo(
            home,
            retainObservedIn(home)({
              identity: { profile: "local-collection", version: 1, path: source },
              input: source,
              retainedAt: "2026-09-16T00:00:00.000Z",
              skills: [
                {
                  name: "raw-review",
                  sourcePath: source,
                  relativePath: "raw-review",
                  observedHash: yield* deterministicTreeHashEffect(source),
                },
              ],
              observations: [],
            }),
          ),
        );
      });
    const first = yield* observe("first verbatim Skill\n");
    const layer = libraryStoreLayer({ home });
    const bound = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.ok(bound);
    yield* writingTo(
      home,
      LibraryStore.use((store) =>
        store.publish({
          ...bound,
          global_bindings: [
            {
              harness: "codex",
              scope: { kind: "global" },
              skills: bound.skills
                .filter((skill) => skill.collection_id === first.collection?.collection_id)
                .map((skill) => skill.skill_id),
            },
          ],
        }),
      ).pipe(Effect.provide(layer)),
    );
    yield* writingTo(
      home,
      projectBindingEffect({
        harness: "codex",
        root: roots.codexRoot,
        variantsPath: join(home, "variants"),
      }).pipe(Effect.provide(layer)),
    );
    assert.strictEqual(
      yield* fs.readFileString(join(roots.codexRoot, "raw-review", "SKILL.md")),
      "first verbatim Skill\n",
    );
    yield* observe("second verbatim Skill\n");
    const beforePin = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.ok(beforePin);
    const collection = beforePin.collections.find(
      (item) => item.collection_id === first.collection?.collection_id,
    );
    assert.ok(collection);
    const skill = beforePin.skills.find((item) => item.collection_id === collection.collection_id);
    assert.ok(skill);
    assert.strictEqual(skill.versions.length, 2);
    const firstVersion = skill.versions.find(
      (item) => item.skill_version_id !== skill.selected_skill_version_id,
    );
    assert.ok(firstVersion);
    const options = {
      home,
      originalsPath: join(home, "originals"),
      query: skill.skill_id,
      version: firstVersion.skill_version_id,
      dryRun: true,
      roots: {
        home: workspace,
        configHome: join(workspace, "config"),
        overrides: {
          codex: roots.codexRoot,
          claude: roots.claudeRoot,
          opencode: roots.opencodeRoot,
          devin: roots.devinRoots,
        },
      },
      variantsPath: join(home, "variants"),
      now: () => "2026-09-16T00:00:00.000Z",
    };
    const plan = yield* executePinEffect(beforePin, options).pipe(Effect.provide(layer));
    assert.strictEqual(plan.kind, "plan");
    assert.strictEqual(plan.value.changed, true);
    assert.strictEqual(
      yield* fs.readFileString(join(roots.codexRoot, "raw-review", "SKILL.md")),
      "first verbatim Skill\n",
    );
    const apply = Effect.gen(function* () {
      const current = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
      assert.ok(current);
      return yield* executePinEffect(current, { ...options, dryRun: false }).pipe(
        Effect.provide(layer),
      );
    });
    const selected = yield* writingTo(home, apply);
    assert.strictEqual(selected.kind, "pinned");
    if (selected.kind !== "pinned") return;
    assert.strictEqual(selected.value.projected, 1);
    assert.strictEqual(
      yield* fs.readFileString(join(roots.codexRoot, "raw-review", "SKILL.md")),
      "first verbatim Skill\n",
    );
    const reloaded = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.ok(reloaded);
    assert.strictEqual(
      reloaded.skills[0]?.selected_skill_version_id,
      firstVersion.skill_version_id,
    );
    const retry = yield* writingTo(home, apply);
    assert.strictEqual(retry.kind, "pinned");
    if (retry.kind !== "pinned") return;
    assert.strictEqual(retry.value.changed, false);
    assert.strictEqual(retry.value.projected, 1);
    assert.strictEqual(reloaded.skills[0]?.versions.length, 2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("previews and retains an exact historical Registry release before selecting it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-pin-release-" });
    const source = join(workspace, "source");
    const firstArchive = join(workspace, "release-1.zip");
    const secondArchive = join(workspace, "release-2.zip");
    yield* copySkitFixtureEffect("authored", source);
    const first = yield* archiveBytes(source, firstArchive);
    const skillPath = join(source, "skills", "review", "SKILL.md");
    yield* fs.writeFileString(
      skillPath,
      (yield* fs.readFileString(skillPath)).replace("# Review", "# New review"),
    );
    const second = yield* archiveBytes(source, secondArchive);
    let requested = "";
    const fixture = yield* libraryHome({
      home: join(workspace, "home"),
      registryBaseUrl: "https://registry.example",
      transport: async (input) => {
        requested = String(input);
        const historical = requested.includes("/1.0.0/");
        return new Response(new Uint8Array(historical ? first : second), {
          headers: {
            "content-type": "application/zip",
            "skit-release-version": historical ? "1.0.0" : "2.0.0",
          },
        });
      },
    });
    yield* initializeLibraryMachine(fixture.home);
    const base = {
      roots: fixture.inventory,
      variantsPath: fixture.bindings.variantsPath,
    };
    yield* fixture.owned(addLibrarySourceEffect({}, "skit:alice/tools", "2.0.0"));
    const before = yield* fixture.durable;
    const collection = before.collections[0]!;
    const preview = yield* fixture.owned(
      executePinEffect(before, {
        ...base,
        query: collection.collection_id,
        version: "1.0.0",
        dryRun: true,
      }),
    );
    assert.strictEqual(preview.kind, "plan");
    assert.strictEqual(preview.value.retained, false);
    assert.strictEqual(preview.value.requested_version, "1.0.0");
    assert.ok(requested.includes("/1.0.0/"));
    assert.strictEqual((yield* fixture.durable).retained_copies.length, 1);

    const applied = yield* fixture.owned(
      executePinEffect(before, {
        ...base,
        query: collection.collection_id,
        version: "1.0.0",
        dryRun: false,
      }),
    );
    assert.strictEqual(applied.kind, "pinned");
    if (applied.kind !== "pinned") return;
    const after = yield* fixture.durable;
    assert.strictEqual(after.retained_copies.length, 2);
    assert.strictEqual(applied.value.skills.length, 1);
    for (const selection of applied.value.skills)
      assert.strictEqual(
        after.skills.find((skill) => skill.skill_id === selection.skill_id)
          ?.selected_skill_version_id,
        selection.selected_version_id,
      );
    assert.strictEqual(applied.value.retained, false);
    assert.strictEqual(applied.value.requested_version, "1.0.0");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
