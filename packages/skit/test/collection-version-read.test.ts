import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import * as Library from "../src/library/library.js";
import { skitLayer } from "../src/platform/layer.js";
import { collectionVersionPath, originalTreeHash } from "../src/library/collection-version.js";
import { readCollectionVersion } from "../src/library/internal/content/read-collection-version.js";
import {
  prepareInstalledSkillRebuild,
  reproducible,
} from "../src/library/installation/retained-skill.js";
import { testRoots } from "./helpers/library-store.js";
import { AuthorHistory } from "../src/author/history.js";
import { AuthorWorkspace } from "../src/author/workspace.js";
import { fileBytesPath, makeFileBytes } from "../src/artifact/file-bytes.js";
import { lockFile } from "../src/platform/file-lock.js";
import { Hash } from "../src/shared/hash.js";
import { SqlClient } from "effect/sql";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { prepareSetupSourceUndo } from "../src/library/internal/setup/undo-sources.js";
import { prepareSetupChanges } from "../src/library/store/setup-intent.js";
import { setupIntent } from "../src/library/store/intent.js";
import { makeImportId } from "../src/library/entity-ids.js";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-composition-fixture-" });
  const home = join(root, "library");
  const originals = join(home, "originals");
  const source = join(root, "source");
  const primary = "---\nname: review\ndescription: Review code\n---\nReview.\n";
  const files = [
    {
      path: "skit.json",
      mode: 0o644 as const,
      text: JSON.stringify({
        slug: "tools",
        skills: [
          { name: "review", path: "skills/review", shared: [{ from: "shared", to: "context" }] },
        ],
      }),
    },
    { path: "skills/review/SKILL.md", mode: 0o644 as const, text: primary },
    { path: "shared/rules.txt", mode: 0o644 as const, text: "shared content\n" },
    { path: "shared/run.sh", mode: 0o755 as const, text: "#!/bin/sh\necho review\n" },
  ];
  for (const file of files) {
    const path = join(source, file.path);
    yield* fs.makeDirectory(dirname(path), { recursive: true });
    yield* fs.writeFileString(path, file.text, { mode: file.mode });
  }
  const imported = yield* Effect.flatMap(Library.Service, (library) =>
    library.import.authored({
      root: source,
      source: { type: "local", path: source },
      input: source,
      importedAt: "2026-11-06T00:00:00.000Z",
    }),
  ).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
  const retained = collectionVersionPath(originals, imported.snapshotDigest);
  // Independent on-disk format fixture: no composition encoder or private writer creates it.
  const entries = [
    ...["skills", "skills/review", "shared"].map((path) => ({ path, kind: "directory" as const })),
    ...files.map((file) => ({
      path: file.path,
      kind: "file" as const,
      mode: file.mode,
      blob: `sha256:${createHash("sha256").update(file.text).digest("hex")}`,
    })),
  ];
  const manifest = { schema: "skit.library-composition.v1", entries };
  const manifestPath = join(
    originals,
    "compositions/trees",
    `${imported.snapshotDigest.slice(7)}.json`,
  );
  const blobPath = (hash: string) => join(originals, "compositions/blobs", hash.slice(7));
  const convert = Effect.gen(function* () {
    yield* fs.makeDirectory(dirname(manifestPath), { recursive: true });
    yield* fs.makeDirectory(join(originals, "compositions/blobs"), { recursive: true });
    for (const file of files) {
      const hash = `sha256:${createHash("sha256").update(file.text).digest("hex")}`;
      yield* fs.writeFileString(blobPath(hash), file.text);
    }
    yield* fs.writeFileString(manifestPath, JSON.stringify(manifest));
    yield* fs.remove(retained, { recursive: true });
  });
  const borrowed: string[] = [];
  const trackReads = FileSystem.FileSystem.of({
    ...fs,
    makeTempDirectoryScoped: (options) =>
      fs.makeTempDirectoryScoped(options).pipe(
        Effect.tap((path) =>
          Effect.sync(() => {
            if (options?.prefix === "skit-composition-read-") borrowed.push(path);
          }),
        ),
      ),
  });
  return {
    fs,
    root,
    home,
    originals,
    source,
    primary,
    imported,
    retained,
    manifest,
    manifestPath,
    blobPath,
    convert,
    borrowed,
    trackReads,
  };
});

it.effect("whole-tree reads keep their path and never create composition storage", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    assert.strictEqual(
      yield* readCollectionVersion(f.originals, f.imported.snapshotDigest),
      f.retained,
    );
    assert.isFalse(yield* f.fs.exists(join(f.originals, "compositions")));
    assert.strictEqual(
      yield* f.fs.readFileString(join(f.retained, "skills/review/SKILL.md")),
      f.primary,
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("Library browsing and checks read compositions without leaking borrowed paths", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const read = Effect.gen(function* () {
      const library = yield* Library.Service;
      const skills = yield* library.skills();
      const skill = skills[0];
      assert.ok(skill);
      const content = yield* library.session.readSkillContent(skill.versionId);
      const description = yield* library.descriptionLoad({
        collection: f.imported.collection.collection_id,
      });
      const checked = yield* library.check(undefined, {
        inspectSource: () => Effect.succeed({ snapshot_digest: f.imported.snapshotDigest }),
      });
      const security = yield* library.securityReview(skill.id);
      return { skills, content, description, checked, security };
    }).pipe(
      Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })),
      Effect.provideService(FileSystem.FileSystem, f.trackReads),
    );
    const original = yield* read;
    yield* f.convert;
    assert.deepStrictEqual(yield* read, original);
    assert.isAbove(f.borrowed.length, 0);
    for (const path of f.borrowed) assert.isFalse(yield* f.fs.exists(path));
    assert.isFalse(yield* f.fs.exists(f.retained));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("restore reuses a composition and opens fresh views across preparation and import", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.convert;
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const manifest = yield* library.manifest;
      const plan = yield* library.content.plan(manifest, []);
      assert.deepStrictEqual(plan.reusable, [f.imported.snapshotDigest]);
      assert.deepStrictEqual(plan.download, []);
      assert.deepStrictEqual(plan.reacquire, []);
      const staged = yield* library.content.stage(manifest, {
        plan,
        registry: { origin: "https://registry.fixture", token: Option.none() },
        download: () => Effect.die("existing composition must not be downloaded"),
      });
      assert.deepStrictEqual(staged.reusable, [f.imported.snapshotDigest]);
      assert.deepStrictEqual(staged.retained, []);
      assert.deepStrictEqual(staged.missing, []);
    }).pipe(
      Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })),
      Effect.provideService(FileSystem.FileSystem, f.trackReads),
    );
    assert.isAtLeast(f.borrowed.length, 2);
    for (const path of f.borrowed) assert.isFalse(yield* f.fs.exists(path));
    assert.isFalse(yield* f.fs.exists(f.retained));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "source Undo verifies compositions while keeping stable evidence and import references",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.convert;
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const before = yield* library.read;
        if (before._tag !== "Present") return yield* Effect.die("Missing first import");
        yield* f.fs.writeFileString(
          join(f.source, "skills/review/SKILL.md"),
          `${f.primary}Changed.\n`,
        );
        yield* library.import.authored({
          root: f.source,
          source: { type: "local", path: f.source },
          input: f.source,
          importedAt: "2026-11-07T00:00:00.000Z",
        });
        const after = yield* library.read;
        if (after._tag !== "Present") return yield* Effect.die("Missing second import");
        const changes = yield* prepareSetupChanges(
          setupIntent(before.state),
          setupIntent(after.state),
          f.home,
        );
        const undo = yield* prepareSetupSourceUndo(
          after.state,
          changes,
          f.originals,
          after.state.imports[0]!.machine_id,
          new Map([
            [
              f.imported.collection.collection_id,
              { importId: makeImportId(), checkedAt: "2026-11-08T00:00:00.000Z" },
            ],
          ]),
        );
        assert.deepStrictEqual(undo.conflicts, []);
        assert.deepStrictEqual(undo.evidence, [
          { path: f.retained, hash: f.imported.snapshotDigest },
        ]);
        assert.strictEqual(undo.restorations.length, 1);
        assert.strictEqual(undo.restorations[0]?.input.value, f.retained);
        assert.strictEqual(
          undo.restorations[0]?.collection_version_id,
          f.imported.collectionVersionId,
        );
      }).pipe(
        Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })),
        Effect.provideService(FileSystem.FileSystem, f.trackReads),
      );
      assert.isAbove(f.borrowed.length, 0);
      for (const path of f.borrowed) assert.isFalse(yield* f.fs.exists(path));
      assert.isFalse(yield* f.fs.exists(f.retained));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "Author and Library composition reads share canonical bytes and retain independent modes and copies",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.convert;
      const content = new TextEncoder().encode("shared content\n");
      const store = yield* Effect.map(AuthorHistory, (history) => history.engineStore).pipe(
        Effect.provide(
          AuthorHistory.layer({ home: f.home }).pipe(Layer.provideMerge(AuthorWorkspace.layer)),
        ),
      );
      const author = yield* store.putTree([
        { kind: "file", path: "shared.txt", mode: 0o644, bytes: content },
      ]);
      const run = f.manifest.entries.find((entry) => entry.path === "shared/run.sh");
      if (run?.kind !== "file") return assert.fail("Missing executable fixture");
      const byteStore = yield* makeFileBytes(f.home);
      yield* byteStore.save(yield* f.fs.readFile(f.blobPath(run.blob)));
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lockFile(join(f.home, "lock.sqlite"));
          const root = yield* readCollectionVersion(f.originals, f.imported.snapshotDigest);
          assert.strictEqual(
            yield* f.fs.readFileString(join(root, "shared/rules.txt")),
            "shared content\n",
          );
          const run = f.manifest.entries.find((entry) => entry.path === "shared/run.sh");
          if (run?.kind !== "file") return assert.fail("Missing executable fixture");
          const canonical = fileBytesPath(f.home, Hash.make(run.blob));
          assert.strictEqual((yield* f.fs.stat(canonical)).mode & 0o777, 0o600);
          assert.strictEqual((yield* f.fs.stat(join(root, "shared/run.sh"))).mode & 0o777, 0o755);
          assert.notStrictEqual(
            (yield* f.fs.stat(canonical)).ino,
            (yield* f.fs.stat(join(root, "shared/run.sh"))).ino,
          );
          yield* f.fs.writeFileString(join(root, "shared/rules.txt"), "edited private read");
        }),
      );
      assert.deepStrictEqual((yield* store.tree(author))[0], {
        kind: "file",
        path: "shared.txt",
        mode: 0o644,
        bytes: content,
      });
      yield* withLibraryDatabase(
        libraryDatabasePath(f.home),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.strictEqual((yield* sql`SELECT hash FROM file_bytes`).length, 2);
          assert.strictEqual((yield* sql`SELECT blob FROM author_tree_entries`).length, 1);
        }),
        true,
      );
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "a registered missing canonical file is refused without repairing it from the legacy composition",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.convert;
      yield* readCollectionVersion(f.originals, f.imported.snapshotDigest);
      const entry = f.manifest.entries.find((entry) => entry.kind === "file");
      if (entry?.kind !== "file") return assert.fail("Missing file");
      const byteStore = yield* makeFileBytes(f.home);
      yield* byteStore.save(yield* f.fs.readFile(f.blobPath(entry.blob)));
      const canonical = fileBytesPath(f.home, Hash.make(entry.blob));
      yield* f.fs.remove(canonical);
      assert.isTrue(yield* f.fs.exists(f.blobPath(entry.blob)));
      assert.strictEqual(
        (yield* Effect.flip(readCollectionVersion(f.originals, f.imported.snapshotDigest)))._tag,
        "InvalidLibraryState",
      );
      assert.isFalse(yield* f.fs.exists(canonical));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("composition read copies are isolated, hash-exact, and removed with their scope", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.convert;
    const borrowed = yield* Effect.scoped(
      Effect.gen(function* () {
        const path = yield* readCollectionVersion(f.originals, f.imported.snapshotDigest);
        assert.notStrictEqual(path, f.retained);
        assert.strictEqual(yield* originalTreeHash(path), f.imported.snapshotDigest);
        assert.isAbove((yield* f.fs.stat(join(path, "shared/run.sh"))).mode & 0o111, 0);
        yield* f.fs.writeFileString(join(path, "shared/rules.txt"), "changed private read");
        return path;
      }),
    );
    assert.isFalse(yield* f.fs.exists(borrowed));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const path = yield* readCollectionVersion(f.originals, f.imported.snapshotDigest);
        assert.strictEqual(
          yield* f.fs.readFileString(join(path, "shared/rules.txt")),
          "shared content\n",
        );
      }),
    );
    assert.strictEqual(
      yield* f.fs.readFileString(join(f.source, "skills/review/SKILL.md")),
      f.primary,
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "public content reads release materializations and installation keeps its caller-owned staging",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.convert;
      const agents = join(f.root, "agents");
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const base = yield* library.read;
        assert.deepStrictEqual(yield* library.content.inspect(base), { _tag: "Intact" });
        const packed = yield* library.content.pack(base);
        assert.strictEqual(packed[0]?.digest, f.imported.snapshotDigest);
        for (const path of f.borrowed) assert.isFalse(yield* f.fs.exists(path));
        const plan = yield* library.plan(
          {
            _tag: "Enabled",
            changes: [
              {
                _tag: "Enable",
                subject: { _tag: "Collection", id: f.imported.collection.collection_id },
                members: "whole",
                where: [{ kind: "global" }],
              },
            ],
          },
          { base },
        );
        assert.strictEqual((yield* library.apply({ _tag: "Apply", plan })).result._tag, "Applied");
        const snapshot = yield* library.read;
        if (snapshot._tag !== "Present") return yield* Effect.die("Missing installed Library");
        const copy = snapshot.state.installed_skills.find(
          (copy) => copy.path === join(agents, "review"),
        );
        assert.ok(copy);
        assert.strictEqual(
          yield* f.fs.readFileString(join(copy.path, "context/rules.txt")),
          "shared content\n",
        );
        const reviewed = yield* prepareInstalledSkillRebuild(snapshot.state, f.originals, copy, {
          source: "declared",
        });
        assert.strictEqual(reviewed.collectionVersionPath, f.retained);
        assert.isFalse(yield* f.fs.exists(reviewed.collectionVersionPath));
        for (const path of f.borrowed) assert.isFalse(yield* f.fs.exists(path));
        const staging = join(f.root, "rebuilt");
        yield* reviewed.build(staging);
        assert.isTrue(yield* f.fs.exists(staging));
        assert.strictEqual(
          yield* f.fs.readFileString(join(staging, "context/rules.txt")),
          "shared content\n",
        );
        assert.isTrue(
          yield* reproducible(copy.path, snapshot.state, f.originals, copy.installed_skill_id),
        );
      }).pipe(
        Effect.provide(
          Library.layer({
            home: f.home,
            roots: {
              home: f.root,
              configHome: join(f.root, "config"),
              overrides: { codex: [agents] },
            },
          }),
        ),
        Effect.provideService(FileSystem.FileSystem, f.trackReads),
      );
      assert.isAbove(f.borrowed.length, 0);
      for (const path of f.borrowed) assert.isFalse(yield* f.fs.exists(path));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

for (const damage of [
  "missing-blob",
  "changed-blob",
  "duplicate",
  "traversal",
  "missing-parent",
  "file-parent",
  "mode",
  "symlink",
  "git-control",
  "workspace-control",
] as const)
  it.effect(
    `public content inspection refuses ${damage} composition damage and cleans borrowed roots`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.convert;
        const escaped = join(dirname(f.root), `${basename(f.root)}-escape`);
        assert.isFalse(yield* f.fs.exists(escaped));
        yield* Effect.addFinalizer(() =>
          f.fs.remove(escaped, { recursive: true, force: true }).pipe(Effect.orDie),
        );
        const file = f.manifest.entries.find((entry) => entry.kind === "file");
        if (file?.kind !== "file") return yield* Effect.die("Missing fixture file");
        let text = JSON.stringify(f.manifest);
        if (damage === "missing-blob") yield* f.fs.remove(f.blobPath(file.blob));
        if (damage === "changed-blob")
          yield* f.fs.writeFileString(f.blobPath(file.blob), "damaged bytes");
        if (damage === "duplicate") f.manifest.entries.push({ path: "skills", kind: "directory" });
        if (damage === "traversal")
          f.manifest.entries.push({ path: `../${basename(f.root)}-escape`, kind: "directory" });
        if (damage === "git-control") f.manifest.entries.push({ path: ".git", kind: "directory" });
        if (damage === "workspace-control")
          f.manifest.entries.push({ path: ".skit", kind: "directory" });
        if (damage === "missing-parent")
          f.manifest.entries = f.manifest.entries.filter((entry) => entry.path !== "skills");
        if (damage === "file-parent")
          f.manifest.entries = f.manifest.entries.map((entry) =>
            entry.path === "skills" ? { ...file, path: "skills" } : entry,
          );
        if (damage === "mode")
          f.manifest.entries = f.manifest.entries.map((entry) =>
            entry.kind === "file" && entry.path === "skills/review/SKILL.md"
              ? { ...entry, mode: 0o755 }
              : entry,
          );
        text =
          damage === "symlink"
            ? JSON.stringify({
                ...f.manifest,
                entries: [
                  ...f.manifest.entries,
                  { path: "link", kind: "symlink", target: f.source },
                ],
              })
            : JSON.stringify(f.manifest);
        yield* f.fs.writeFileString(f.manifestPath, text);
        const refused = yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          return yield* Effect.result(library.content.inspect(yield* library.read));
        }).pipe(
          Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })),
          Effect.provideService(FileSystem.FileSystem, f.trackReads),
        );
        if (refused._tag !== "Failure")
          return yield* Effect.die("Damaged composition was accepted");
        assert.strictEqual(refused.failure._tag, "InvalidLibraryState");
        for (const path of f.borrowed) assert.isFalse(yield* f.fs.exists(path));
        assert.isFalse(yield* f.fs.exists(escaped));
      }).pipe(Effect.scoped, Effect.provide(skitLayer)),
  );
