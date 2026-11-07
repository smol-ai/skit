import { originalTreePath } from "./helpers/original-tree.js";
import { testPlatformLayer } from "./helpers/platform.js";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";

import * as Library from "@smolai/skit-core/library";
import { assert, it } from "@effect/vitest";
import { Layer, Effect, FileSystem, Ref } from "effect";
import { join } from "node:path";

import { importSource, inspectLibrarySource } from "../src/library/source.js";
import { initializeLibraryMachine } from "./helpers/library-home.js";
import { testRoots } from "./helpers/roots.js";

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
      Effect.provide(Library.layer({ home, roots: testRoots(home) })),
    );
    const read = Effect.flatMap(Library.Service, (library) => library.read).pipe(
      Effect.provide(Library.layer({ home, roots: testRoots(home) })),
    );
    const loaded = yield* read;
    assert.strictEqual(loaded._tag, "Present");
    if (loaded._tag !== "Present") return;
    const beforeState = yield* fs.readFileString(join(home, "state.json"));
    const checkedCollections = yield* Ref.make<ReadonlyArray<string>>([]);
    /** The check as the command runs it, with the CLI's Registry source inspection. */
    const check = (
      query: string,
      onCollection?: (collection: { display_name: string }) => Effect.Effect<void>,
    ) =>
      Effect.flatMap(Library.Service, (library) =>
        library.check(query, { inspectSource: inspectLibrarySource, onCollection }),
      ).pipe(
        Effect.provide(
          Library.layer({ home, roots: testRoots(home) }).pipe(
            Layer.provideMerge(skitConfigurationLayer(home)),
          ),
        ),
      );
    const current = yield* check(imported.collection_id, (collection) =>
      Ref.update(checkedCollections, (names) => [...names, collection.display_name]),
    );
    assert.strictEqual(current[0]?.collection_versions[0]?.original_intact, true);
    assert.deepStrictEqual(yield* Ref.get(checkedCollections), []);
    assert.strictEqual(current[0]?.source_status, "not-applicable");
    assert.strictEqual(current[0]?.available_snapshot_digest, undefined);
    yield* fs.writeFileString(join(source, "SKILL.md"), "changed source bytes\n");
    const path = originalTreePath(
      join(home, "originals"),
      loaded.state.collection_versions[0]!.hash,
    );
    yield* fs.writeFileString(join(path, "SKILL.md"), "changed retained bytes\n");
    const changed = yield* check(imported.collection_id);
    assert.strictEqual(changed[0]?.collection_versions[0]?.original_intact, false);
    assert.strictEqual(changed[0]?.source_status, "not-applicable");
    assert.strictEqual(changed[0]?.available_snapshot_digest, undefined);
    yield* fs.remove(source, { recursive: true });
    const withoutCopy = yield* check(imported.collection_id);
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
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
