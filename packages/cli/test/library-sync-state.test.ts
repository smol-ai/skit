import { NodeFileSystem } from "@effect/platform-node";
import { currentLibraryManifest } from "@smolai/skit-core";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { readAcceptedBaseEffect } from "../src/workflows/library/library-sync-state.js";

const acceptedBase = {
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
};

const obsoleteBase = {
  schemaVersion: 1,
  libraryId: "legacy-library",
  revisionId: "legacy-revision",
  baseManifest: { schema: "skit.library.v2", entries: [], bindings: [] },
};

it.effect("reads the pre-rename portable base past the obsolete v2 sync file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-base-" });
    yield* fs.writeFileString(join(home, "library-sync.json"), JSON.stringify(obsoleteBase));
    yield* fs.writeFileString(
      join(home, "portable-library-sync.json"),
      JSON.stringify(acceptedBase),
    );

    const accepted = yield* readAcceptedBaseEffect(home);
    assert.strictEqual(accepted?.library_id, "current-library");
    assert.strictEqual(accepted?.revision_id, "current-revision");
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("reads the portable base when the renamed file does not exist", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-base-" });
    yield* fs.writeFileString(
      join(home, "portable-library-sync.json"),
      JSON.stringify(acceptedBase),
    );

    const accepted = yield* readAcceptedBaseEffect(home);
    assert.strictEqual(accepted?.library_id, "current-library");
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("rejects an obsolete sync base when no portable base remains", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-base-" });
    const path = join(home, "library-sync.json");
    yield* fs.writeFileString(path, JSON.stringify(obsoleteBase));

    const failure = yield* readAcceptedBaseEffect(home).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "Library.AcceptedBaseInvalid");
    if (failure._tag === "Library.AcceptedBaseInvalid") assert.strictEqual(failure.path, path);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("attributes an invalid portable base to its own path", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-base-" });
    const path = join(home, "portable-library-sync.json");
    yield* fs.writeFileString(path, "{}");

    const failure = yield* readAcceptedBaseEffect(home).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "Library.AcceptedBaseInvalid");
    if (failure._tag === "Library.AcceptedBaseInvalid") assert.strictEqual(failure.path, path);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
