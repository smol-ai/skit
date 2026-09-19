import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { LibraryStore, libraryStoreLayer, retainedTreePath, skitLayer } from "@smolai/skit-core";
import {
  addPortableLibrarySourceEffect,
  previewPortableLibrarySourceEffect,
} from "../src/workflows/library/portable-add.js";
import {
  planPortableUpdatesEffect,
  updatePortableCollectionsEffect,
} from "../src/workflows/library/portable-update.js";
import { initializeLibraryMachine } from "./helpers/library-home.js";
import { rendererTestLayer } from "./helpers/renderer.js";

it.effect("previews without mutation, then retains exact root Skill bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-portable-add-" });
    const source = join(root, "source");
    const home = join(root, "home");
    yield* fs.makeDirectory(source);
    yield* initializeLibraryMachine(home);
    const bytes = "---\nname: review\ndescription: Review carefully\n---\n\nDo the review.\n";
    yield* fs.writeFileString(join(source, "SKILL.md"), bytes);
    const options = {};
    assert.deepStrictEqual(yield* previewPortableLibrarySourceEffect(options, source), {
      kind: "plain",
      skills: [{ name: "review", verbatim_path: "." }],
    });
    assert.strictEqual(yield* fs.exists(join(home, "state.json")), false);

    const added = yield* addPortableLibrarySourceEffect({}, source).pipe(
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
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-portable-add-nested-" });
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
    const added = yield* addPortableLibrarySourceEffect({}, source).pipe(
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

it.effect("retains a changed source as a second Skill Version and leaves selection explicit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-portable-update-" });
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
    const added = yield* addPortableLibrarySourceEffect({}, source).pipe(
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
      (yield* planPortableUpdatesEffect(before, options, added.collection_id))[0]?.changed,
      true,
    );
    const statuses: string[] = [];
    yield* updatePortableCollectionsEffect(before, options, added.collection_id).pipe(
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
    const added = yield* addPortableLibrarySourceEffect({}, source).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    yield* fs.writeFileString(
      join(source, ".skit-ownership.json"),
      '{"schemaVersion":1,"projectionId":"projection-test"}\n',
    );
    const update = (state: Parameters<typeof updatePortableCollectionsEffect>[0]) =>
      updatePortableCollectionsEffect(state, options, added.collection_id).pipe(
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
