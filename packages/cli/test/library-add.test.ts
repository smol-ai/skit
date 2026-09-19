import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { LibraryStore, libraryStoreLayer, retainedTreePath, skitLayer } from "@smolai/skit-core";
import {
  addLibrarySourceEffect,
  previewLibrarySourceEffect,
} from "../src/workflows/library/add.js";
import { planUpdatesEffect, updateSubjectsEffect } from "../src/workflows/library/update.js";
import { checkSubjectsEffect } from "../src/workflows/library/check.js";
import { initializeLibraryMachine } from "./helpers/library-home.js";
import { rendererTestLayer } from "./helpers/renderer.js";

it.effect("previews without mutation, then retains exact root Skill bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-add-" });
    const source = join(root, "source");
    const home = join(root, "home");
    yield* fs.makeDirectory(source);
    yield* initializeLibraryMachine(home);
    const bytes = "---\nname: review\ndescription: Review carefully\n---\n\nDo the review.\n";
    yield* fs.writeFileString(join(source, "SKILL.md"), bytes);
    const options = {};
    assert.deepStrictEqual(yield* previewLibrarySourceEffect(options, source), {
      kind: "plain",
      skills: [{ name: "review", verbatim_path: "." }],
    });
    assert.strictEqual(yield* fs.exists(join(home, "state.json")), false);

    const added = yield* addLibrarySourceEffect({}, source).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    const state = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    assert.strictEqual(state.collections.length, 1);
    assert.strictEqual(state.skills[0]?.name, "review");
    assert.strictEqual(state.retained_copies[0]?.retained_copy_id, added.retained_version_id);
    assert.strictEqual(
      yield* fs.readFileString(
        join(retainedTreePath(join(home, "originals"), added.snapshot_digest), "SKILL.md"),
      ),
      bytes,
    );
    assert.strictEqual(state.collections[0]?.upstream, undefined);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("retains nested Skills as one Collection with independent Skill identities", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-add-nested-" });
    const source = join(root, "source");
    const home = join(root, "home");
    yield* initializeLibraryMachine(home);
    for (const name of ["review", "plan"]) {
      const path = join(source, "skills", name);
      yield* fs.makeDirectory(path, { recursive: true });
      yield* fs.writeFileString(
        join(path, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\n`,
      );
    }
    const added = yield* addLibrarySourceEffect({}, source).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    const state = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    assert.deepStrictEqual(added.skills.map((skill) => skill.verbatim_path).sort(), [
      "skills/plan",
      "skills/review",
    ]);
    assert.strictEqual(
      state.skills.filter((skill) => skill.collection_id === state.collections[0]?.collection_id)
        .length,
      2,
    );
    assert.deepStrictEqual(state.skills.map((skill) => skill.name).sort(), ["plan", "review"]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("checks and updates a selected well-known Skill as a standalone subject", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-standalone-update-" });
    const home = join(root, "home");
    yield* initializeLibraryMachine(home);
    const base = "https://skills.example.test";
    const original = "---\nname: review\ndescription: Review.\n---\n\n# Original\n";
    const updated = "---\nname: review\ndescription: Review.\n---\n\n# Updated\n";
    let artifact = original;
    const client = HttpClient.make((request) => {
      const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
      const index = JSON.stringify({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "review",
            description: "Review.",
            type: "skill-md",
            url: "/review/SKILL.md",
            digest,
          },
        ],
      });
      const body = request.url.endsWith("/.well-known/agent-skills/index.json")
        ? index
        : request.url.endsWith("/review/SKILL.md")
          ? artifact
          : "missing";
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, { status: body === "missing" ? 404 : 200 }),
        ),
      );
    });
    const source = { type: "well-known" as const, ref: base, members: ["review"] };
    const options = {
      roots: { home: root, configHome: join(root, "config"), overrides: {} },
      variantsPath: join(home, "variants"),
    };
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(libraryStoreLayer({ home })),
        Effect.provideService(HttpClient.HttpClient, client),
      );
    const added = yield* run(addLibrarySourceEffect({}, source));
    const before = yield* run(Effect.flatMap(LibraryStore, (store) => store.load));
    assert.strictEqual(before.collections.length, 0);
    const skill = before.skills[0]!;
    assert.strictEqual(skill.collection_id, undefined);
    assert.strictEqual(skill.upstream?.selection.kind, "selected-skills");
    assert.strictEqual(
      (yield* run(checkSubjectsEffect(before, {}, skill.skill_id)))[0]?.source_status,
      "current",
    );
    artifact = updated;
    assert.strictEqual(
      (yield* run(planUpdatesEffect(before, options, skill.skill_id)))[0]?.changed,
      true,
    );
    const result = yield* run(
      updateSubjectsEffect(before, options, skill.skill_id).pipe(
        Effect.provide(rendererTestLayer()),
      ),
    );
    assert.strictEqual(result[0]?.changed, true);
    const after = yield* run(Effect.flatMap(LibraryStore, (store) => store.load));
    assert.strictEqual(after.collections.length, 0);
    assert.strictEqual(after.skills[0]?.skill_id, added.skill_ids[0]);
    assert.strictEqual(after.skills[0]?.versions.length, 2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("retains a changed source as a second Skill Version and leaves selection explicit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-update-" });
    const source = join(root, "source");
    const home = join(root, "home");
    yield* fs.makeDirectory(source);
    yield* initializeLibraryMachine(home);
    yield* fs.writeFileString(
      join(source, "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\nfirst\n",
    );
    const options = {
      roots: { home: root, configHome: join(root, "config"), overrides: {} },
      variantsPath: join(home, "variants"),
    };
    const added = yield* addLibrarySourceEffect({}, source).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    yield* fs.writeFileString(
      join(source, "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\nsecond\n",
    );
    const before = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    assert.strictEqual(
      (yield* planUpdatesEffect(before, options, added.collection_id))[0]?.changed,
      true,
    );
    const statuses: string[] = [];
    yield* updateSubjectsEffect(before, options, added.collection_id).pipe(
      Effect.provide(libraryStoreLayer({ home })),
      Effect.provide(
        rendererTestLayer({
          withStatus: (status, operation) =>
            Effect.sync(() =>
              statuses.push(typeof status === "string" ? status : status.pending),
            ).pipe(Effect.andThen(operation)),
        }),
      ),
    );
    const after = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    assert.strictEqual(after.skills[0]?.versions.length, 2);
    assert.ok(after.skills[0]?.selected_skill_version_id);
    assert.strictEqual(after.retained_copies.length, 2);
    assert.deepStrictEqual(statuses, [
      `${after.collections[0]?.label} · Fetching and inspecting Source`,
      `${after.collections[0]?.label} · Updating projected Skills`,
    ]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("repeated updates record acquisitions without inventing snapshot changes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-portable-current-" });
    const source = join(root, "source");
    const home = join(root, "home");
    yield* fs.makeDirectory(source);
    yield* initializeLibraryMachine(home);
    yield* fs.writeFileString(
      join(source, "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\ncurrent\n",
    );
    const options = {
      roots: { home: root, configHome: join(root, "config"), overrides: {} },
      variantsPath: join(home, "variants"),
    };
    const added = yield* addLibrarySourceEffect({}, source).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    yield* fs.writeFileString(
      join(source, ".skit-ownership.json"),
      '{"schemaVersion":1,"projectionId":"projection-test"}\n',
    );
    const update = (state: Parameters<typeof updateSubjectsEffect>[0]) =>
      updateSubjectsEffect(state, options, added.collection_id).pipe(
        Effect.provide(libraryStoreLayer({ home })),
        Effect.provide(rendererTestLayer()),
      );
    const load = Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );

    const first = yield* update(yield* load);
    const second = yield* update(yield* load);
    const after = yield* load;

    assert.strictEqual(first[0]?.changed, false);
    assert.strictEqual(second[0]?.changed, false);
    assert.strictEqual(after.retained_copies.length, 1);
    assert.strictEqual(after.acquisitions.length, 3);
    assert.strictEqual(
      yield* fs.exists(
        join(
          retainedTreePath(join(home, "originals"), added.snapshot_digest),
          ".skit-ownership.json",
        ),
      ),
      false,
    );
    assert.ok(
      after.acquisitions.every(
        (acquisition) => acquisition.retained_copy_id === added.retained_version_id,
      ),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
