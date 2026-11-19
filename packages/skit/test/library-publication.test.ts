import { inspectLocalLibraryState } from "../src/library/store/state-file.js";
import { prepareSetupChanges } from "../src/library/store/setup-intent.js";
import { prepareLibraryDifference, prepareLibrarySide } from "../src/library/store/difference.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import {
  decodeLibraryState,
  libraryManifestFromLocalState,
  libraryStateRevision,
  type LibraryState,
} from "../src/library/library-state.js";
import {
  loadLibrary,
  loadOperations,
  LibraryWriter,
  writeLibrary,
} from "../src/library/store/library-store.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import { recordedLibrary, setupIntent } from "../src/library/store/intent.js";
import { makeOperationId, type OperationId } from "../src/library/entity-ids.js";
import { snapshotOf } from "../src/library/snapshot.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { reverseSetupIntent } from "../src/library/internal/setup/undo-intent.js";
import { runUndo } from "../src/library/internal/setup/undo-execution.js";
import { Digest } from "effect/crypto";
import { canonicalJson } from "../src/shared/json.js";
import { skitLayer } from "../src/platform/layer.js";
import { fixture } from "./helpers/library-values.js";
import { saveLibrary, testRoots } from "./helpers/library-store.js";
import { SqlClient } from "effect/sql";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";

it.effect(
  "a prepared Sync boundary saves by its captured revision without reloading unrelated rows",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-native-publication-" });
      const { state } = yield* fixture;
      yield* saveLibrary(home, state);
      const snapshot = yield* inspectLocalLibraryState(home);
      if (!snapshot.present) return yield* Effect.die("Missing prepared Library");
      const next = yield* decodeLibraryState({
        ...snapshot.state,
        collections: snapshot.state.collections.map((row, index) =>
          index === 0 ? { ...row, label: "Changed by Sync" } : row,
        ),
        enabled: [{ skill: snapshot.state.skills[0]!.skill_id }],
      });
      const path = libraryDatabasePath(home);
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO library_scan_issues(position,code,path,harness) VALUES(9999,'FUTURE_ISSUE','/unrelated','codex')`;
        }),
      );
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const stale = yield* Effect.flip(
            writer.save(next, snapshot.state, snapshot.revision - 1),
          );
          assert.strictEqual(stale._tag, "LibraryChanged");
          yield* writer.save(next, snapshot.state, snapshot.revision);
          assert.strictEqual(yield* writer.revision, snapshot.revision + 1);
        }),
      );
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT code FROM library_scan_issues WHERE position=9999`,
            [{ code: "FUTURE_ISSUE" }],
          );
          yield* sql`DELETE FROM library_scan_issues WHERE position=9999`;
        }),
      );
      assert.deepStrictEqual(yield* loadLibrary(home), next);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "Undo saves the exact recorded target and resumes after that save with unknown fields intact",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-undo-publication-" });
      const { state } = yield* fixture;
      const skill = state.skills[0];
      assert.ok(skill);
      const before = yield* decodeLibraryState({
        ...state,
        installed_skills: [],
        repositories: [],
        enabled: [{ skill: skill.skill_id }],
        extension: { absent: null, nested: ["keep", {}] },
      });
      const reversed = reverseSetupIntent(
        before,
        yield* prepareSetupChanges(
          setupIntent({ ...before, enabled: [] }),
          setupIntent(before),
          "fixture",
        ),
      );
      assert.deepStrictEqual(reversed.conflicts, []);
      const after = yield* decodeLibraryState(reversed.state);
      assert.notStrictEqual(libraryStateRevision(before), libraryStateRevision(after));
      const program = {
        operationId: makeOperationId(),
        backupId: "b56f90ec-d27f-41cf-805f-6234fe1c2810",
        difference: yield* prepareLibraryDifference(before, after, home),
        files: [],
        paths: [],
        sources: [],
        sourceImports: [],
        actions: [],
        preserve: [],
        preserved: true,
      };
      const operationId = makeOperationId();
      const pending = OperationStatus.cases.Pending.make({
        operationId,
        before: recordedLibrary(before),
        steps: [{ step: { _tag: "Undo", program }, before: [], after: [], status: "Pending" }],
      });
      yield* saveLibrary(home, before);
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const target = OperationStatus.cases.Pending.make({
            operationId: program.operationId,
            steps: [],
            before: { installedSkills: [] },
            setup: {
              changes: yield* prepareSetupChanges(setupIntent(before), setupIntent(before), home),
            },
          });
          yield* writer.recordOperation(
            target,
            snapshotOf(yield* inspectLocalLibraryState(home)),
            "setup",
          );
          yield* writer.settleOperation(target);
        }),
      );
      // Stop at the executor's return: the Library is saved, but its caller has not marked Done.
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          yield* writer.recordOperation(
            pending,
            snapshotOf(yield* inspectLocalLibraryState(home)),
            "undo",
          );
          yield* runUndo(operationId, 0, program);
        }),
      );
      const saved = yield* loadLibrary(home);
      assert.deepStrictEqual(saved, after);
      assert.strictEqual(canonicalJson(saved), canonicalJson(after));
      assert.strictEqual(libraryStateRevision(saved), libraryStateRevision(after));
      assert.strictEqual(
        (yield* loadOperations(home)).find((row) => row.operationId === operationId)?.steps[0]
          ?.status,
        "Pending",
      );
      assert.strictEqual(
        (yield* loadOperations(home)).find((row) => row.operationId === program.operationId)?._tag,
        "Undone",
      );
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        assert.deepStrictEqual(library.startup.finished, [operationId]);
        assert.deepStrictEqual(library.startup.stopped, []);
        assert.deepStrictEqual(yield* loadLibrary(home), after);
      }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Sync saves its recorded extensions exactly and resumes after publication", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-publication-" }),
    );
    const home = join(root, "library");
    const source = join(root, "source");
    const skills = join(root, "skills");
    const installed = join(skills, "review");
    const bytes = "---\nname: review\ndescription: Publication fixture\n---\nOriginal bytes\n";
    yield* fs.makeDirectory(source);
    yield* fs.writeFileString(join(source, "SKILL.md"), bytes);
    const layer = Library.layer({
      home,
      roots: { home: root, configHome: root, overrides: { codex: [skills] } },
    });
    const seed = yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const request = yield* localImportRequest(source, "2026-11-16T00:00:00.000Z");
      if (Option.isNone(request)) return assert.fail("Missing source");
      const imported = yield* library.import.collection(request.value);
      const skill = imported.skills[0];
      assert.ok(skill);
      const plan = yield* library.plan(
        {
          _tag: "Enabled",
          changes: [
            {
              _tag: "Enable",
              subject: { _tag: "Skill", id: skill.skill_id },
              where: [{ kind: "global" }],
            },
          ],
        },
        { base: yield* library.read },
      );
      yield* library.apply({ _tag: "Apply", plan });
      const snapshot = yield* library.read;
      if (snapshot._tag !== "Present") return assert.fail("Missing Library");
      return {
        manifest: yield* libraryManifestFromLocalState(snapshot.state),
        archives: yield* library.content.pack(snapshot),
      };
    }).pipe(Effect.provide(layer));
    const sync = Effect.gen(function* () {
      const library = yield* Library.Service;
      const base = yield* library.read;
      const staged = yield* library.content.stage(seed.manifest, {
        localArchives: seed.archives,
        registry: { origin: "https://registry.fixture", token: Option.none() },
      });
      const plan = yield* library.plan(
        {
          _tag: "Sync",
          staged,
          acceptedBase:
            base._tag === "Present"
              ? Option.fromUndefinedOr(base.state.sync_ancestry)
              : Option.none(),
          deviceSelection: Option.none(),
          pendingOrigin: Option.none(),
          remote: Option.some({
            origin: "https://registry.fixture",
            libraryId: Option.some("library_fixture"),
          }),
        },
        { base },
      );
      if (!Library.isRemoteSyncPlan(plan)) return assert.fail("Expected remote plan");
      const ancestry = {
        origin: "https://registry.fixture",
        library_id: "library_fixture",
        revision_id: "revision_fixture",
        base_manifest: seed.manifest,
      };
      return yield* library.apply({
        _tag: "ApplySynced",
        plan,
        receipt: {
          origin: ancestry.origin,
          libraryId: ancestry.library_id,
          revisionId: ancestry.revision_id,
          manifestDigest: staged.manifestDigest,
          ancestry,
        },
      });
    });
    yield* sync.pipe(Effect.provide(layer));
    const state = yield* loadLibrary(home);
    const before = yield* decodeLibraryState({
      ...state,
      extension: { nested: [null, "keep"] },
      skills: state.skills.map((skill) => ({
        ...skill,
        extension: "skill",
        versions: skill.versions.map((version) => ({
          ...version,
          extension: { nested: ["version"] },
        })),
      })),
      installed_skills: state.installed_skills.map((copy) => ({ ...copy, extension: "installed" })),
    });
    yield* saveLibrary(home, before);
    // A native deletion requires work. The preview also removes the installed-row extension,
    // making the publication necessary even though the clean Library body stays unchanged.
    yield* fs.remove(installed, { recursive: true });
    const digest = yield* Digest.Digest;
    let recorded: { operationId: OperationId; after: LibraryState } | undefined;
    const interruptedFs: FileSystem.FileSystem = {
      ...fs,
      chmod: (path, mode) =>
        Effect.gen(function* () {
          yield* fs.chmod(path, mode);
          if (path !== join(home, "library.sqlite") || recorded) return;
          const operations = yield* loadOperations(home).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.orDie,
          );
          const operation = operations.find((operation) => operation._tag === "Pending");
          const step = operation?.steps[0]?.step;
          if (
            operation?._tag !== "Pending" ||
            step?._tag !== "Sync" ||
            step.phase !== "retire" ||
            operation.steps[0]?.status !== "Done" ||
            operation.steps[1]?.status !== "Pending"
          )
            return;
          const live = yield* loadLibrary(home).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Digest.Digest, digest),
            Effect.orDie,
          );
          const after = yield* prepareLibrarySide(
            step.program.difference,
            live,
            "after",
            home,
          ).pipe(Effect.provideService(Digest.Digest, digest), Effect.orDie);
          if (canonicalJson(live.installed_skills) !== canonicalJson(after.installed_skills))
            return;
          recorded = { operationId: operation.operationId, after };
          return yield* Effect.die("Stopped after Sync target save");
        }),
    };
    const result = yield* Effect.exit(
      sync.pipe(
        Effect.provide(
          layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, interruptedFs))),
        ),
      ),
    );
    assert.strictEqual(result._tag, "Failure");
    const completedSave = recorded;
    assert.ok(completedSave);
    assert.deepStrictEqual(
      { ...completedSave.after, installed_skills: [] },
      { ...before, installed_skills: [] },
    );
    const saved = yield* loadLibrary(home);
    assert.deepStrictEqual(saved, completedSave.after);
    assert.strictEqual(canonicalJson(saved), canonicalJson(completedSave.after));
    assert.strictEqual(libraryStateRevision(saved), libraryStateRevision(completedSave.after));
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      assert.deepStrictEqual(library.startup.finished, [completedSave.operationId]);
      assert.deepStrictEqual(library.startup.stopped, []);
      assert.deepStrictEqual(
        { ...(yield* loadLibrary(home)), installed_skills: [] },
        { ...before, installed_skills: [] },
      );
    }).pipe(Effect.provide(layer));
    assert.isFalse(yield* fs.exists(installed));
    assert.strictEqual(yield* fs.readFileString(join(source, "SKILL.md")), bytes);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
