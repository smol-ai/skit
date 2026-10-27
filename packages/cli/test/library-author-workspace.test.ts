import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import {
  COLLECTION_CONTROL_DIRECTORY,
  AUTHOR_WORKSPACE_METADATA_FILE,
  LibraryStore,
  retainedTreePath,
  skitLayer,
} from "@smolai/skit-core";
import { assertDiskUnchanged, captureDisk } from "./helpers/disk-snapshot.js";
import { retainLibrarySource } from "../src/library-application/retain-source.js";
import { executeRemove } from "../src/workflows/library/remove.js";
import { systemError } from "effect/PlatformError";
import {
  ensureAuthorWorkspaceRegistered,
  type AuthorWorkspaceOptions,
} from "../src/library/author-workspace.js";
import {
  copySkitFixtureEffect,
  initializeLibraryMachine,
  libraryHome,
  scratch,
} from "./helpers/library-home.js";

it.effect(
  "registers and refreshes an authored workspace as Skill Versions and Retained Trees",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-portable-author-");
      const source = join(root, "source");
      yield* copySkitFixtureEffect("authored", source);
      const home = yield* libraryHome({ home: join(root, "home") });
      yield* initializeLibraryMachine(home.home);
      const options = {
        workspaceId: () => `workspace_${"a".repeat(32)}`,
      };
      const first = yield* home.owned(ensureAuthorWorkspaceRegistered(source, options));
      assert.ok(first.entry);
      assert.strictEqual(
        first.entry.collection?.upstream?.source_identity.kind,
        "authored-workspace",
      );
      const firstState = yield* home.owned(Effect.flatMap(LibraryStore, (store) => store.load));
      assert.strictEqual(firstState.retained_copies.length, 1);
      const firstTree = firstState.retained_copies[0];
      assert.ok(firstTree);
      assert.strictEqual(
        yield* fs.exists(join(retainedTreePath(home.originals, firstTree.digest), "skit.json")),
        true,
      );

      const skillPath = join(source, "skills", "review", "SKILL.md");
      yield* fs.writeFileString(skillPath, `${yield* fs.readFileString(skillPath)}\nUpdated.\n`);
      const refreshed = yield* home.owned(ensureAuthorWorkspaceRegistered(source, options));
      assert.ok(refreshed.entry);
      assert.strictEqual(
        refreshed.entry.collection?.collection_id,
        first.entry.collection?.collection_id,
      );
      const state = yield* home.owned(Effect.flatMap(LibraryStore, (store) => store.load));
      assert.strictEqual(state.collections.length, 1);
      // The refreshed tree is retained alongside the first.
      assert.deepStrictEqual(
        state.retained_copies.map((copy) => copy.digest === firstTree.digest),
        [true, false],
      );
      assert.strictEqual(state.skills.find((skill) => skill.name === "review")?.versions.length, 2);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

const workspaceFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* scratch("skit-workspace-lifecycle-");
  const source = join(root, "source");
  yield* copySkitFixtureEffect("authored", source);
  const home = yield* libraryHome({ home: join(root, "home") });
  yield* initializeLibraryMachine(home.home);
  const path = join(source, COLLECTION_CONTROL_DIRECTORY, AUTHOR_WORKSPACE_METADATA_FILE);
  const ensure = (options: AuthorWorkspaceOptions = {}) =>
    home.owned(ensureAuthorWorkspaceRegistered(source, options));
  const metadata = fs.readFileString(path).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            workspace_id: Schema.String,
            registration: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    ),
  );
  return { fs, root, source, home, path, ensure, metadata };
});

it.effect("recovers a missing workspace document from the retained identity", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    const first = yield* f.ensure();
    const before = yield* f.metadata;
    yield* f.fs.remove(f.path);
    const recovered = yield* f.ensure({
      workspaceId: () => {
        throw new Error("identity must be recovered");
      },
    });
    assert.strictEqual(
      recovered.entry?.collection.collection_id,
      first.entry?.collection.collection_id,
    );
    assert.deepStrictEqual(yield* f.metadata, before);
    assert.strictEqual((yield* f.home.durable).collections.length, 1);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("rejects a copied workspace identity before scaffolding or publishing", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    yield* f.ensure();
    const copy = join(f.root, "copy");
    yield* f.fs.copy(f.source, copy);
    const before = yield* captureDisk([f.source, copy, f.home.home], { identity: true });
    const failure = yield* Effect.flip(
      f.home.owned(ensureAuthorWorkspaceRegistered(copy, { scaffold: true })),
    );
    assert.strictEqual(failure._tag, "AuthorWorkspaceAlreadyRegistered");
    yield* assertDiskUnchanged(before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("removal requires explicit re-registration and preserves workspace identity", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    const first = yield* f.ensure();
    assert.ok(first.entry);
    const identity = (yield* f.metadata).workspace_id;
    const state = yield* f.home.durable;
    yield* f.home.owned(
      executeRemove(state, { query: first.entry.collection.collection_id, dryRun: false }),
    );
    assert.strictEqual((yield* f.metadata).registration, "removed");
    assert.strictEqual((yield* f.ensure()).entry, undefined);
    assert.strictEqual((yield* f.home.durable).collections.length, 0);
    const registered = yield* f.ensure({ register: true });
    assert.ok(registered.entry);
    assert.deepStrictEqual(yield* f.metadata, {
      workspace_id: identity,
      registration: "registered",
    });
    assert.strictEqual((yield* f.home.durable).collections.length, 1);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("removal leaves a different workspace identity untouched", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    const first = yield* f.ensure();
    assert.ok(first.entry);
    const replacement = JSON.stringify({
      schema: "skit.author-workspace.v1",
      workspace_id: `workspace_${"b".repeat(32)}`,
      registration: "registered",
    });
    yield* f.fs.writeFileString(f.path, replacement);
    yield* f.home.owned(
      executeRemove(yield* f.home.durable, {
        query: first.entry.collection.collection_id,
        dryRun: false,
      }),
    );
    assert.strictEqual(yield* f.fs.readFileString(f.path), replacement);
    assert.strictEqual((yield* f.home.durable).collections.length, 0);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a failed registration marker leaves retained bytes and identity available for retry",
  () =>
    Effect.gen(function* () {
      const f = yield* workspaceFixture;
      const failure = yield* Effect.flip(
        f.ensure().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            rename: (from, to) =>
              to === f.path
                ? Effect.fail(
                    systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: to,
                    }),
                  )
                : f.fs.rename(from, to),
          }),
        ),
      );
      assert.strictEqual(failure._tag, "PlatformError");
      const pending = yield* f.metadata;
      assert.strictEqual(pending.registration, undefined);
      const retained = yield* f.home.durable;
      assert.strictEqual(retained.collections.length, 1);
      const copy = retained.retained_copies[0]!;
      assert.isTrue(
        yield* f.fs.exists(join(retainedTreePath(f.home.originals, copy.digest), "skit.json")),
      );
      const retried = yield* f.ensure();
      assert.strictEqual(
        retried.entry?.collection.collection_id,
        retained.collections[0]?.collection_id,
      );
      assert.strictEqual((yield* f.metadata).workspace_id, pending.workspace_id);
      assert.strictEqual((yield* f.metadata).registration, "registered");
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "rejects a directory already retained outside workspace registration before scaffolding",
  () =>
    Effect.gen(function* () {
      const f = yield* workspaceFixture;
      yield* f.home.owned(retainLibrarySource(f.source));
      const before = yield* captureDisk([f.source, f.home.home], { identity: true });
      const failure = yield* Effect.flip(f.ensure({ scaffold: true }));
      assert.strictEqual(failure._tag, "DirectoryAlreadyRetained");
      yield* assertDiskUnchanged(before);
      assert.isFalse(yield* f.fs.exists(f.path));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
