import { NodeFileSystem } from "@effect/platform-node";
import { currentLibraryManifest } from "@smolai/skit-core";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { readAcceptedBaseEffect } from "../src/workflows/library/library-sync-state.js";

it.effect("reads the pre-rename portable base past the obsolete v2 sync file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-base-" });
    yield* fs.writeFileString(
      join(home, "library-sync.json"),
      JSON.stringify({
        schemaVersion: 1,
        libraryId: "legacy-library",
        revisionId: "legacy-revision",
        baseManifest: { schema: "skit.library.v2", entries: [], bindings: [] },
      }),
    );
    yield* fs.writeFileString(
      join(home, "portable-library-sync.json"),
      JSON.stringify({
        schemaVersion: 1,
        origin: "https://registry.example",
        library_id: "current-library",
        revision_id: "current-revision",
        base_manifest: currentLibraryManifest({
          collections: [],
          skills: [],
          retained_copies: [],
          acquisitions: [],
          snapshot_digests: [],
          bindings: [],
        }),
      }),
    );

    const accepted = yield* readAcceptedBaseEffect(home);
    assert.strictEqual(accepted?.library_id, "current-library");
    assert.strictEqual(accepted?.revision_id, "current-revision");
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
