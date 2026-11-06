import { assert, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Schema, Scope } from "effect";
import { join } from "node:path";
import {
  COLLECTION_CONTROL_DIRECTORY,
  AUTHOR_WORKSPACE_METADATA_FILE,
  collectionVersionPath,
} from "@smolai/skit-core";
import { skitLayer } from "@smolai/skit-core/platform";
import { assertDiskUnchanged, captureDisk } from "./helpers/disk-snapshot.js";
import { holdHomeLock } from "./helpers/home-lock.js";
import { importSource } from "../src/library/source.js";
import { executeRemove } from "../src/library/remove/operation.js";
import { authorInitCommand } from "../src/author/init.js";
import { authorInvocationCommand } from "../src/author/invocation.js";
import { AuthorWorkspace } from "@smolai/skit-core/author";
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
      const first = yield* home.owned(authorInitCommand(source, false));
      assert.ok(first.entry);
      assert.strictEqual(
        first.entry.collection?.upstream?.source_identity.kind,
        "authored-workspace",
      );
      const firstState = yield* home.durable;
      assert.strictEqual(firstState.collection_versions.length, 1);
      const firstTree = firstState.collection_versions[0];
      assert.ok(firstTree);
      assert.strictEqual(
        yield* fs.exists(join(collectionVersionPath(home.originals, firstTree.hash), "skit.json")),
        true,
      );

      const skillPath = join(source, "skills", "review", "SKILL.md");
      yield* fs.writeFileString(skillPath, `${yield* fs.readFileString(skillPath)}\nUpdated.\n`);
      const refreshed = yield* home.owned(authorInitCommand(source, false));
      assert.ok(refreshed.entry);
      assert.strictEqual(
        refreshed.entry.collection?.collection_id,
        first.entry.collection?.collection_id,
      );
      const state = yield* home.durable;
      assert.strictEqual(state.collections.length, 1);
      // The refreshed tree is retained alongside the first.
      assert.deepStrictEqual(
        state.collection_versions.map((copy) => copy.hash === firstTree.hash),
        [true, false],
      );
      assert.strictEqual(state.skills.find((skill) => skill.name === "review")?.versions.length, 2);
    }).pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped),
);

const workspaceFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* scratch("skit-workspace-lifecycle-");
  const source = join(root, "source");
  yield* copySkitFixtureEffect("authored", source);
  const home = yield* libraryHome({ home: join(root, "home") });
  yield* initializeLibraryMachine(home.home);
  const path = join(source, COLLECTION_CONTROL_DIRECTORY, AUTHOR_WORKSPACE_METADATA_FILE);
  const init = (register = false, path = source) => home.owned(authorInitCommand(path, register));
  const metadataAt = (directory: string) =>
    fs
      .readFileString(join(directory, COLLECTION_CONTROL_DIRECTORY, AUTHOR_WORKSPACE_METADATA_FILE))
      .pipe(
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
  return { fs, root, source, home, path, init, metadata: metadataAt(source), metadataAt };
});

it.effect("built-in Author edits refuse a held workspace lease while preview stays passive", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    yield* f.init();
    const metadataPath = join(f.source, "skills", "review", "agents", "openai.yaml");
    yield* f.fs.writeFileString(metadataPath, "policy:\n  allow_implicit_invocation: true\n");
    const workspaces = yield* AuthorWorkspace;
    const root = yield* workspaces.resolveRoot(f.source);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* workspaces.acquire(root);
        const before = yield* captureDisk([f.source, f.home.home], { identity: true });
        const initFailure = yield* Effect.flip(f.init());
        assert.strictEqual(initFailure._tag, "AuthorWorkspaceBusy");
        const invocationFailure = yield* Effect.flip(authorInvocationCommand(f.source, false));
        assert.strictEqual(invocationFailure._tag, "AuthorWorkspaceBusy");
        const preview = yield* authorInvocationCommand(f.source, true);
        assert.isTrue(preview.generated.some((item) => item.changed));
        yield* assertDiskUnchanged(before);
      }),
    );
    // Releasing the competing lease lets both real command callers run again.
    yield* f.init();
    const generated = yield* authorInvocationCommand(f.source, false);
    assert.isTrue(generated.generated.some((item) => item.changed));
    assert.strictEqual(
      yield* f.fs.readFileString(metadataPath),
      "policy:\n  allow_implicit_invocation: false\n",
    );
  }).pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("recovers a missing workspace document from the retained identity", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    const first = yield* f.init();
    const before = yield* f.metadata;
    yield* f.fs.remove(f.path);
    const recovered = yield* f.init();
    assert.strictEqual(
      recovered.entry?.collection.collection_id,
      first.entry?.collection.collection_id,
    );
    assert.deepStrictEqual(yield* f.metadata, before);
    assert.strictEqual((yield* f.home.durable).collections.length, 1);
  }).pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("initializing through a symlink reuses the canonical workspace claim", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    const first = yield* f.init();
    const identity = yield* f.metadata;
    const alias = join(f.root, "alias");
    yield* f.fs.symlink(f.source, alias);
    const again = yield* f.init(false, alias);
    assert.strictEqual(
      again.entry?.collection.collection_id,
      first.entry?.collection.collection_id,
    );
    assert.deepStrictEqual(yield* f.metadata, identity);
    assert.strictEqual((yield* f.home.durable).collections.length, 1);
  }).pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("rejects a copied workspace identity before scaffolding or publishing", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    yield* f.init();
    const copy = join(f.root, "copy");
    yield* f.fs.copy(f.source, copy);
    const before = yield* captureDisk([f.source, copy, f.home.home], { identity: true });
    const failure = yield* Effect.flip(f.init(false, copy));
    assert.strictEqual(failure._tag, "AuthorWorkspaceAlreadyRegistered");
    yield* assertDiskUnchanged(before);
  }).pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each(["collection", "skill"] as const)(
  "%s removal requires explicit re-registration and preserves workspace identity",
  (subject) =>
    Effect.gen(function* () {
      const f = yield* workspaceFixture;
      const first = yield* f.init();
      assert.ok(first.entry);
      const skill = first.entry.skills[0];
      assert.ok(skill);
      const identity = (yield* f.metadata).workspace_id;
      yield* f.home.owned(
        executeRemove({
          query: subject === "collection" ? first.entry.collection.collection_id : skill.skill_id,
          dryRun: false,
        }),
      );
      assert.strictEqual((yield* f.metadata).registration, "removed");
      assert.strictEqual((yield* f.init()).entry, undefined);
      assert.strictEqual((yield* f.home.durable).collections.length, 0);
      const registered = yield* f.init(true);
      assert.ok(registered.entry);
      assert.deepStrictEqual(yield* f.metadata, {
        workspace_id: identity,
        registration: "registered",
      });
      assert.strictEqual((yield* f.home.durable).collections.length, 1);
    }).pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("sole-Skill removal respects the workspace lease while preview stays passive", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    const first = yield* f.init();
    const skill = first.entry?.skills[0];
    assert.ok(skill);
    const workspaces = yield* AuthorWorkspace;
    const root = yield* workspaces.resolveRoot(f.source);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* workspaces.acquire(root);
        const before = yield* captureDisk([f.source, f.home.home], { identity: true });
        const preview = yield* f.home.owned(executeRemove({ query: skill.skill_id, dryRun: true }));
        assert.strictEqual(preview.kind, "plan");
        const refused = yield* f.home.owned(
          Effect.result(executeRemove({ query: skill.skill_id, dryRun: false })),
        );
        if (refused._tag !== "Failure")
          return yield* Effect.die("Removal bypassed the held workspace lease");
        assert.strictEqual(refused.failure._tag, "AuthorWorkspaceBusy");
        yield* assertDiskUnchanged(before);
      }),
    );
    const removed = yield* f.home.owned(executeRemove({ query: skill.skill_id, dryRun: false }));
    assert.strictEqual(removed.kind, "removed");
    assert.strictEqual((yield* f.metadata).registration, "removed");
    assert.strictEqual((yield* f.home.durable).collections.length, 0);
  }).pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("removal leaves a different workspace identity untouched", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    const first = yield* f.init();
    assert.ok(first.entry);
    const replacement = JSON.stringify({
      schema: "skit.author-workspace.v1",
      workspace_id: `workspace_${"b".repeat(32)}`,
      registration: "registered",
    });
    yield* f.fs.writeFileString(f.path, replacement);
    yield* f.home.owned(
      executeRemove({
        query: first.entry.collection.collection_id,
        dryRun: false,
      }),
    );
    assert.strictEqual(yield* f.fs.readFileString(f.path), replacement);
    assert.strictEqual((yield* f.home.durable).collections.length, 0);
  }).pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a refused Library import leaves the workspace registered for a retry", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    // Another process holds the Library writer, so Library refuses the import.
    const other = yield* Scope.make();
    yield* holdHomeLock(f.home.home).pipe(Scope.provide(other));
    const failure = yield* Effect.flip(f.init());
    assert.strictEqual(failure._tag, "HomeBusy");
    const pending = yield* f.metadata;
    assert.strictEqual(pending.registration, "registered");
    assert.strictEqual((yield* f.home.snapshot)._tag, "Absent");
    yield* Scope.close(other, Exit.void);
    const retried = yield* f.init();
    assert.ok(retried.entry);
    assert.strictEqual((yield* f.metadata).workspace_id, pending.workspace_id);
    assert.strictEqual((yield* f.home.durable).collections.length, 1);
  }).pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "rejects a directory already retained outside workspace registration before scaffolding",
  () =>
    Effect.gen(function* () {
      const f = yield* workspaceFixture;
      yield* f.home.owned(importSource(f.source));
      const before = yield* captureDisk([f.home.home], { identity: true });
      const descriptor = yield* f.fs.readFileString(join(f.source, "skit.json"));
      const failure = yield* Effect.flip(f.init());
      assert.strictEqual(failure._tag, "DirectoryAlreadyInLibrary");
      yield* assertDiskUnchanged(before);
      // The lease's own files may exist; no identity, and no scaffold, was written.
      assert.isFalse(yield* f.fs.exists(f.path));
      assert.strictEqual(yield* f.fs.readFileString(join(f.source, "skit.json")), descriptor);
    }).pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each(["collection", "skill"] as const)(
  "removing by %s opts out the moved workspace rather than its historical path",
  (subject) =>
    Effect.gen(function* () {
      const f = yield* workspaceFixture;
      const first = yield* f.init();
      assert.ok(first.entry);
      const identity = (yield* f.metadata).workspace_id;
      const moved = join(f.root, "moved");
      yield* f.fs.rename(f.source, moved);
      const refreshed = yield* f.init(false, moved);
      assert.strictEqual(
        refreshed.entry?.collection.collection_id,
        first.entry.collection.collection_id,
      );
      assert.strictEqual((yield* f.metadataAt(moved)).workspace_id, identity);
      const skill = first.entry.skills[0];
      assert.ok(skill);
      yield* f.home.owned(
        executeRemove({
          query: subject === "collection" ? first.entry.collection.collection_id : skill.skill_id,
          dryRun: false,
        }),
      );
      assert.strictEqual((yield* f.metadataAt(moved)).registration, "removed");
      assert.strictEqual((yield* f.init(false, moved)).entry, undefined);
      assert.strictEqual((yield* f.home.durable).collections.length, 0);
      assert.isFalse(yield* f.fs.exists(f.source));
    }).pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a copied identity is rejected after its original workspace moved", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    yield* f.init();
    const moved = join(f.root, "moved");
    yield* f.fs.rename(f.source, moved);
    yield* f.init(false, moved);
    const copy = join(f.root, "copy");
    yield* f.fs.copy(moved, copy);
    const before = yield* captureDisk([moved, copy, f.home.home], { identity: true });
    const failure = yield* Effect.flip(f.init(false, copy));
    assert.strictEqual(failure._tag, "AuthorWorkspaceAlreadyRegistered");
    yield* assertDiskUnchanged(before);
  }).pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a reused historical path gets a distinct workspace instead of adopting the moved identity",
  () =>
    Effect.gen(function* () {
      const f = yield* workspaceFixture;
      const first = yield* f.init();
      assert.ok(first.entry);
      const identity = (yield* f.metadata).workspace_id;
      const moved = join(f.root, "moved");
      yield* f.fs.rename(f.source, moved);
      yield* f.init(false, moved);
      yield* copySkitFixtureEffect("authored", f.source);
      const replacement = yield* f.init();
      assert.ok(replacement.entry);
      assert.notStrictEqual(
        replacement.entry.collection.collection_id,
        first.entry.collection.collection_id,
      );
      assert.notStrictEqual((yield* f.metadata).workspace_id, identity);
      assert.strictEqual((yield* f.home.durable).collections.length, 2);
      // The current moved folder still belongs to its own Collection and identity.
      const again = yield* f.init(false, moved);
      assert.strictEqual(
        again.entry?.collection.collection_id,
        first.entry.collection.collection_id,
      );
    }).pipe(Effect.provide(AuthorWorkspace.layer), Effect.provide(skitLayer), Effect.scoped),
);
