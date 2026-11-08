import { DatabaseSync } from "node:sqlite";
import { originalTreePath } from "./helpers/original-tree.js";
import { assert, it } from "@effect/vitest";
import { Layer, Effect, Exit, FileSystem, Schema, Scope } from "effect";
import { join } from "node:path";
import { skitLayer } from "@smolai/skit-core/platform";
import { assertDiskUnchanged, captureDisk } from "./helpers/disk-snapshot.js";
import { holdHomeLock } from "./helpers/home-lock.js";
import { importSource } from "../src/library/source.js";
import { authorInitCommand } from "../src/author/init.js";
import { authorInvocationCommand } from "../src/author/invocation.js";
import { authorWorkspaceLayer, initSkit } from "@smolai/skit-core/author";
import * as Library from "@smolai/skit-core/library";
import { systemError } from "effect/PlatformError";
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
      const first = yield* home.owned(authorInitCommand(source));
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
        yield* fs.exists(join(originalTreePath(home.originals, firstTree.hash), "skit.json")),
        true,
      );

      const skillPath = join(source, "skills", "review", "SKILL.md");
      yield* fs.writeFileString(skillPath, `${yield* fs.readFileString(skillPath)}\nUpdated.\n`);
      const refreshed = yield* home.owned(authorInitCommand(source));
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
    }).pipe(
      Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))),
      Effect.scoped,
    ),
);

const workspaceFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* scratch("skit-workspace-lifecycle-");
  const source = join(root, "source");
  yield* copySkitFixtureEffect("authored", source);
  const home = yield* libraryHome({ home: join(root, "home") });
  yield* initializeLibraryMachine(home.home);
  const path = join(source, ".skit", "workspace.json");
  const init = (path = source) => home.owned(authorInitCommand(path));
  const metadataAt = (directory: string) =>
    fs.readFileString(join(directory, ".skit", "workspace.json")).pipe(
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
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const db = new DatabaseSync(join(f.source, ".skit", "lock.sqlite"));
            db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
            return db;
          }),
          (db) => Effect.sync(() => db.close()),
        );
        const before = yield* captureDisk([f.source, f.home.home], { identity: true });
        const scaffoldFailure = yield* Effect.flip(initSkit(f.source));
        assert.strictEqual(scaffoldFailure._tag, "AuthorWorkspaceBusy");
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
  }).pipe(Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))), Effect.scoped),
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
  }).pipe(Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))), Effect.scoped),
);

it.effect("initializing through a symlink reuses the canonical workspace claim", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    const first = yield* f.init();
    const identity = yield* f.metadata;
    const alias = join(f.root, "alias");
    yield* f.fs.symlink(f.source, alias);
    const again = yield* f.init(alias);
    assert.strictEqual(
      again.entry?.collection.collection_id,
      first.entry?.collection.collection_id,
    );
    assert.deepStrictEqual(yield* f.metadata, identity);
    assert.strictEqual((yield* f.home.durable).collections.length, 1);
  }).pipe(Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))), Effect.scoped),
);

it.effect("rejects a copied workspace identity before scaffolding or publishing", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    yield* f.init();
    const copy = join(f.root, "copy");
    yield* f.fs.copy(f.source, copy);
    const before = yield* captureDisk([f.source, copy, f.home.home], { identity: true });
    const failure = yield* Effect.flip(f.init(copy));
    assert.strictEqual(failure._tag, "AuthorWorkspaceAlreadyRegistered");
    yield* assertDiskUnchanged(before);
  }).pipe(Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))), Effect.scoped),
);

it.effect.each(["collection", "skill"] as const)(
  "%s removal keeps the workspace identity, and init imports the Collection again",
  (subject) =>
    Effect.gen(function* () {
      const f = yield* workspaceFixture;
      const first = yield* f.init();
      assert.ok(first.entry);
      const skill = first.entry.skills[0];
      assert.ok(skill);
      const identity = (yield* f.metadata).workspace_id;
      yield* f.home.owned(
        Effect.flatMap(Library.Service, (library) =>
          library.remove({
            query: subject === "collection" ? first.entry.collection.collection_id : skill.skill_id,
            dryRun: false,
          }),
        ),
      );
      assert.deepStrictEqual(yield* f.metadata, { workspace_id: identity });
      assert.strictEqual((yield* f.home.durable).collections.length, 0);
      const registered = yield* f.init();
      assert.ok(registered.entry);
      assert.deepStrictEqual(yield* f.metadata, { workspace_id: identity });
      assert.strictEqual((yield* f.home.durable).collections.length, 1);
    }).pipe(
      Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))),
      Effect.scoped,
    ),
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
      Effect.flatMap(Library.Service, (library) =>
        library.remove({
          query: first.entry.collection.collection_id,
          dryRun: false,
        }),
      ),
    );
    assert.strictEqual(yield* f.fs.readFileString(f.path), replacement);
    assert.strictEqual((yield* f.home.durable).collections.length, 0);
  }).pipe(Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))), Effect.scoped),
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
    assert.ok(pending.workspace_id);
    assert.strictEqual((yield* f.home.snapshot)._tag, "Absent");
    yield* Scope.close(other, Exit.void);
    const retried = yield* f.init();
    assert.ok(retried.entry);
    assert.strictEqual((yield* f.metadata).workspace_id, pending.workspace_id);
    assert.strictEqual((yield* f.home.durable).collections.length, 1);
  }).pipe(Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))), Effect.scoped),
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
    }).pipe(
      Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))),
      Effect.scoped,
    ),
);

it.effect.each(["collection", "skill"] as const)(
  "removing by %s removes the moved workspace's Collection; init imports it again",
  (subject) =>
    Effect.gen(function* () {
      const f = yield* workspaceFixture;
      const first = yield* f.init();
      assert.ok(first.entry);
      const identity = (yield* f.metadata).workspace_id;
      const moved = join(f.root, "moved");
      yield* f.fs.rename(f.source, moved);
      const refreshed = yield* f.init(moved);
      assert.strictEqual(
        refreshed.entry?.collection.collection_id,
        first.entry.collection.collection_id,
      );
      assert.strictEqual((yield* f.metadataAt(moved)).workspace_id, identity);
      const skill = first.entry.skills[0];
      assert.ok(skill);
      yield* f.home.owned(
        Effect.flatMap(Library.Service, (library) =>
          library.remove({
            query: subject === "collection" ? first.entry.collection.collection_id : skill.skill_id,
            dryRun: false,
          }),
        ),
      );
      assert.strictEqual((yield* f.metadataAt(moved)).workspace_id, identity);
      assert.strictEqual((yield* f.home.durable).collections.length, 0);
      assert.isFalse(yield* f.fs.exists(f.source));
      assert.ok((yield* f.init(moved)).entry);
      assert.strictEqual((yield* f.home.durable).collections.length, 1);
    }).pipe(
      Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))),
      Effect.scoped,
    ),
);

it.effect("a copied identity is rejected after its original workspace moved", () =>
  Effect.gen(function* () {
    const f = yield* workspaceFixture;
    yield* f.init();
    const moved = join(f.root, "moved");
    yield* f.fs.rename(f.source, moved);
    yield* f.init(moved);
    const copy = join(f.root, "copy");
    yield* f.fs.copy(moved, copy);
    const before = yield* captureDisk([moved, copy, f.home.home], { identity: true });
    const failure = yield* Effect.flip(f.init(copy));
    assert.strictEqual(failure._tag, "AuthorWorkspaceAlreadyRegistered");
    yield* assertDiskUnchanged(before);
  }).pipe(Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))), Effect.scoped),
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
      yield* f.init(moved);
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
      const again = yield* f.init(moved);
      assert.strictEqual(
        again.entry?.collection.collection_id,
        first.entry.collection.collection_id,
      );
    }).pipe(
      Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))),
      Effect.scoped,
    ),
);

it.effect(
  "a refused folder removal leaves the Library Stopped and the files intact until a retry",
  () =>
    Effect.gen(function* () {
      const f = yield* workspaceFixture;
      const first = yield* f.init();
      assert.ok(first.entry);
      const agents = join(f.root, "agents");
      const installed = join(agents, "review");
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const plan = yield* library.plan(
          {
            _tag: "Enabled",
            changes: [
              {
                _tag: "Enable",
                subject: { _tag: "Collection", id: first.entry.collection.collection_id },
                members: "whole",
                where: [{ kind: "global" }],
              },
            ],
          },
          { base: yield* library.read },
        );
        assert.strictEqual((yield* library.apply({ _tag: "Apply", plan })).result._tag, "Applied");
      }).pipe(
        Effect.provide(
          Library.layer({
            home: f.home.home,
            roots: { ...f.home.inventory, overrides: { codex: [agents] } },
          }),
        ),
      );
      const bytes = yield* f.fs.readFileString(join(installed, "SKILL.md"));
      const authored = yield* f.fs.readFileString(join(f.source, "skills/review/SKILL.md"));
      let refusals = 0;
      const failed = yield* f.home
        .owned(
          Effect.gen(function* () {
            const result = yield* Effect.result(
              Effect.flatMap(Library.Service, (library) =>
                library.remove({ query: first.entry.collection.collection_id, dryRun: false }),
              ),
            );
            return { result, snapshot: yield* (yield* Library.Service).read };
          }),
        )
        .pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            rename: (from, to) =>
              from === installed
                ? Effect.gen(function* () {
                    refusals++;
                    return yield* systemError({
                      module: "FileSystem",
                      method: "rename",
                      _tag: "PermissionDenied",
                      pathOrDescriptor: from,
                      syscall: "rename",
                      description: "Test refuses installed-folder removal",
                    });
                  })
                : f.fs.rename(from, to),
          }),
        );
      assert.isAbove(refusals, 0);
      if (failed.result._tag !== "Failure") return yield* Effect.die("Removal falsely succeeded");
      assert.strictEqual(failed.result.failure._tag, "PlatformError");
      assert.strictEqual(failed.snapshot._tag, "Present");
      if (failed.snapshot._tag === "Present") {
        assert.strictEqual(failed.snapshot.state.collections.length, 1);
        assert.isTrue(
          failed.snapshot.state.operations.some((operation) => operation._tag === "Stopped"),
        );
      }
      assert.strictEqual(yield* f.fs.readFileString(join(installed, "SKILL.md")), bytes);
      assert.strictEqual(
        yield* f.fs.readFileString(join(f.source, "skills/review/SKILL.md")),
        authored,
      );
      // A typed refusal is Stopped, not a crash-Pending program: nothing retries it silently.
      const retried = yield* f.home.owned(
        Effect.flatMap(Library.Service, (library) =>
          library.remove({ query: first.entry.collection.collection_id, dryRun: false }),
        ),
      );
      assert.strictEqual(retried.kind, "removed");
      assert.strictEqual((yield* f.home.durable).collections.length, 0);
      assert.isFalse(yield* f.fs.exists(installed));
    }).pipe(
      Effect.provide(authorWorkspaceLayer.pipe(Layer.provideMerge(skitLayer))),
      Effect.scoped,
    ),
);
