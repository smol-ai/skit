import { skitConfigurationLayer } from "@smolai/skit-core";
import { Library } from "@smolai/skit-core/library";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Ref } from "effect";
import { join } from "node:path";
import { collectionVersionPath, skitLayer } from "@smolai/skit-core";
import { checkSubjects } from "../src/library/workflows/check.js";
import { importSource } from "../src/library/application/import-source.js";
import { initializeLibraryMachine } from "./helpers/library-home.js";

it.effect("checks retained files without treating an observed local copy as an upstream", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-check-" });
    const home = join(workspace, "library");
    const source = join(workspace, "raw-review");
    yield* fs.makeDirectory(source, { recursive: true });
    yield* initializeLibraryMachine(home);
    yield* fs.writeFileString(join(source, "SKILL.md"), "observed raw Skill\n");
    const imported = yield* importSource(source).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
    );
    const read = Effect.flatMap(Library.Service, (library) => library.read).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
    );
    const loaded = yield* read;
    assert.strictEqual(loaded._tag, "Present");
    if (loaded._tag !== "Present") return;
    const beforeState = yield* fs.readFileString(join(home, "state.json"));
    const checkedCollections = yield* Ref.make<ReadonlyArray<string>>([]);
    const current = yield* checkSubjects(imported.collection_id, (collection) =>
      Ref.update(checkedCollections, (names) => [...names, collection.display_name]),
    ).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
      Effect.provide(skitConfigurationLayer(home)),
    );
    assert.strictEqual(current[0]?.collection_versions[0]?.original_intact, true);
    assert.deepStrictEqual(yield* Ref.get(checkedCollections), []);
    assert.strictEqual(current[0]?.source_status, "not-applicable");
    assert.strictEqual(current[0]?.available_snapshot_digest, undefined);
    yield* fs.writeFileString(join(source, "SKILL.md"), "changed source bytes\n");
    const path = collectionVersionPath(
      join(home, "originals"),
      loaded.state.collection_versions[0]!.hash,
    );
    yield* fs.writeFileString(join(path, "SKILL.md"), "changed retained bytes\n");
    const changed = yield* checkSubjects(imported.collection_id).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
      Effect.provide(skitConfigurationLayer(home)),
    );
    assert.strictEqual(changed[0]?.collection_versions[0]?.original_intact, false);
    assert.strictEqual(changed[0]?.source_status, "not-applicable");
    assert.strictEqual(changed[0]?.available_snapshot_digest, undefined);
    yield* fs.remove(source, { recursive: true });
    const withoutCopy = yield* checkSubjects(imported.collection_id).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
      Effect.provide(skitConfigurationLayer(home)),
    );
    assert.strictEqual(withoutCopy[0]?.source_status, "not-applicable");
    assert.strictEqual(
      withoutCopy[0]?.current_snapshot_digest,
      loaded.state.collection_versions[0]!.hash,
    );
    assert.strictEqual(withoutCopy[0]?.available_snapshot_digest, undefined);
    assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), beforeState);
    const reloaded = yield* read;
    assert.strictEqual(reloaded._tag, "Present");
    if (reloaded._tag !== "Present") return;
    assert.deepStrictEqual(
      reloaded.state.collection_versions[0]?.hash,
      loaded.state.collection_versions[0]?.hash,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
