import { pendingInstalledSkillBackups } from "../src/installed-skills/backups.js";
import { loadOperations, loadLibrary } from "../src/library/store/library-store.js";
import { assert, it } from "@effect/vitest";
import { Cause, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { systemError } from "effect/PlatformError";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { declaredFixture as valuesFixture } from "./helpers/library-values.js";
import { LibraryStateFields } from "../src/library/store/state-fields.js";
import { LibraryStateDocument, libraryStateRevision } from "../src/library/library-state.js";

import type { Plan } from "../src/library/library-plan.js";
import { currentSkillVersion, versionBacking } from "../src/library/library-contracts.js";
import { collectionVersionPath } from "../src/library/collection-version.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";

import { InstalledApply, OperationStatus } from "../src/library/store/state-schema.js";
import { SqlClient, Statement } from "effect/sql";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { saveLibrary, testRoots } from "./helpers/library-store.js";

type Operation = "enable" | "disable" | "update" | "remove" | "uninstall";
type Boundary = "recorded" | "folder" | "successor" | "completion" | "directory" | "settlement";
const bytes = (text: string) =>
  `---\nname: review\ndescription: Recorded apply fixture\n---\n${text}\n`;

const fixture = Effect.fn("test.applyRecovery.fixture")(function* (
  operation: Operation,
  missingRoot = false,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "skit-apply-recovery-" }),
  );
  const home = join(root, "library");
  const source = join(root, "source");
  const skills = join(root, "skills");
  const installed = join(skills, "review");
  yield* fs.makeDirectory(source);
  if (!missingRoot) yield* fs.makeDirectory(skills);
  yield* fs.writeFileString(join(source, "SKILL.md"), bytes("Original"));
  const layer = Library.layer({
    home,
    roots: { home: root, configHome: root, overrides: { codex: [skills] } },
  });
  const plan = yield* Effect.gen(function* () {
    const library = yield* Library.Service;
    const request = yield* localImportRequest(source, "2026-11-05T00:00:00.000Z");
    if (Option.isNone(request)) return yield* Effect.die("Missing source");
    const imported = yield* library.import.collection(request.value);
    const skill = imported.skills[0]!;
    const intent: Library.Intent = {
      _tag: "Enabled",
      changes: [
        {
          _tag: "Enable",
          subject: { _tag: "Skill", id: skill.skill_id },
          where: [{ kind: "global" }],
        },
      ],
    };
    if (operation !== "enable")
      yield* library.apply({
        _tag: "Apply",
        plan: yield* library.plan(intent, { base: yield* library.read }),
      });
    if (operation === "update") {
      yield* fs.writeFileString(join(source, "SKILL.md"), bytes("Updated"));
      const changed = yield* localImportRequest(source, "2026-11-05T01:00:00.000Z");
      if (Option.isNone(changed)) return yield* Effect.die("Missing updated source");
      yield* library.import.collection(changed.value);
    }
    const snapshot = yield* library.read;
    if (operation === "enable") return yield* library.plan(intent, { base: snapshot });
    if (operation === "disable")
      return yield* library.plan(
        { ...intent, changes: [{ ...intent.changes[0]!, _tag: "Disable" }] },
        { base: snapshot },
      );
    if (operation === "update") return yield* library.plan({ _tag: "Update" }, { base: snapshot });
    if (operation === "remove")
      return yield* library.plan(
        { _tag: "Remove", collectionId: imported.collection.collection_id },
        { base: snapshot },
      );
    if (snapshot._tag !== "Present") return yield* Effect.die("Missing seeded Library");
    return yield* library.plan(
      {
        _tag: "Uninstall",
        copies: snapshot.state.installed_skills.map((copy) => copy.installed_skill_id),
        drop: [],
      },
      { base: snapshot },
    );
  }).pipe(Effect.provide(layer));
  return { fs, root, home, source, skills, installed, layer, plan };
});

const interrupt = Effect.fn("test.applyRecovery.interrupt")(function* (
  f: Omit<Effect.Success<ReturnType<typeof fixture>>, "plan"> & { readonly plan: Plan },
  boundary: Boundary,
) {
  let crashed = false;
  const fs: FileSystem.FileSystem = {
    ...f.fs,
    makeDirectory: (path, options) =>
      Effect.gen(function* () {
        if (!crashed && boundary === "recorded" && path === f.skills) {
          crashed = true;
          return yield* Effect.die("Process exited before creating skills directory");
        }
        yield* f.fs.makeDirectory(path, options);
        if (!crashed && boundary === "directory" && path === f.skills) {
          crashed = true;
          return yield* Effect.die("Process exited after creating skills directory");
        }
      }),
    readDirectory: (path) =>
      Effect.gen(function* () {
        if (!crashed && boundary === "settlement" && path === join(f.root, ".skit-backups")) {
          if (
            (yield* loadOperations(f.home).pipe(
              Effect.provideService(FileSystem.FileSystem, f.fs),
              Effect.orDie,
            )).some(
              (operation) =>
                operation._tag === "Pending" &&
                operation.steps.some(
                  (step) => step.step._tag === "Apply" && step.step.phase._tag === "Done",
                ),
            )
          ) {
            crashed = true;
            return yield* Effect.die("Process exited before backup settlement");
          }
        }
        return yield* f.fs.readDirectory(path);
      }),
    chmod: (path, mode) =>
      Effect.gen(function* () {
        if (!crashed && path === libraryDatabasePath(f.home)) {
          const operation = (yield* loadOperations(f.home).pipe(
            Effect.provideService(FileSystem.FileSystem, f.fs),
            Effect.orDie,
          )).at(-1);
          const step = operation?._tag === "Pending" ? operation.steps[0] : undefined;
          if (
            operation?._tag === "Pending" &&
            step?.step._tag === "Apply" &&
            ((boundary === "recorded" && step.step.phase._tag === "Pending") ||
              (boundary === "completion" && step.step.phase._tag === "Done"))
          ) {
            crashed = true;
            return yield* Effect.die("Process exited at " + boundary);
          }
        }
        yield* f.fs.chmod(path, mode);
      }),
    rename: (from, to) =>
      Effect.gen(function* () {
        yield* f.fs.rename(from, to);
        if (
          !crashed &&
          ((boundary === "folder" &&
            (to === f.installed || (from === f.installed && to.includes(".skit-backups")))) ||
            (boundary === "successor" && to === f.installed))
        ) {
          crashed = true;
          return yield* Effect.die("Process exited after changing the skill folder");
        }
      }),
  };
  const result = yield* Effect.exit(
    Effect.flatMap(Library.Service, (library) =>
      library.apply({ _tag: "Apply", plan: f.plan }),
    ).pipe(Effect.provide(f.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, fs))))),
  );
  assert.strictEqual(result._tag, "Failure");
  assert.isTrue(crashed);

  const operation = (yield* loadOperations(f.home).pipe(
    Effect.provideService(FileSystem.FileSystem, f.fs),
    Effect.orDie,
  )).at(-1);
  assert.strictEqual(operation?._tag, "Pending");
  if (operation?._tag !== "Pending") return yield* Effect.die("Missing durable operation");
  return operation;
});

for (const operation of ["enable", "disable", "update", "remove", "uninstall"] as const)
  for (const boundary of (operation === "update"
    ? ["recorded", "folder", "successor", "completion"]
    : ["recorded", "folder", "completion"]) satisfies readonly Boundary[])
    it.effect(`${operation} resumes after ${boundary} using recorded routing and identities`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(operation);
        const interrupted = yield* interrupt(f, boundary);
        const saved = interrupted.steps[0]?.step;
        if (saved?._tag !== "Apply") return yield* Effect.die("Missing recorded review");
        assert.isTrue(Schema.is(InstalledApply)(saved));
        assert.isFalse(Object.hasOwn(saved, "before"));
        assert.isFalse(Object.hasOwn(saved, "next"));
        const recovered = yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          assert.deepStrictEqual(library.startup.finished, [interrupted.operationId]);
          assert.deepStrictEqual(library.startup.stopped, []);
          return yield* library.read;
        }).pipe(Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })));
        if (recovered._tag !== "Present") return yield* Effect.die("Missing recovered Library");
        const installed = operation === "enable" || operation === "update";
        assert.strictEqual(yield* f.fs.exists(f.installed), installed);
        if (installed) {
          assert.strictEqual(
            yield* f.fs.readFileString(join(f.installed, "SKILL.md")),
            bytes(operation === "update" ? "Updated" : "Original"),
          );
          assert.strictEqual(
            recovered.state.installed_skills[0]?.installed_skill_id,
            saved.changes.find((change) => change._tag === "Install" || change._tag === "Save")?.row
              .installed_skill_id,
          );
        }
        if (operation === "remove") assert.deepStrictEqual(recovered.state.collections, []);
        const again = yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          assert.deepStrictEqual(library.startup.finished, []);
          return yield* library.read;
        }).pipe(Effect.provide(f.layer));
        assert.strictEqual(again.revision, recovered.revision);
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.source, "SKILL.md")),
          bytes(operation === "update" ? "Updated" : "Original"),
        );
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );

for (const changed of ["skill", "parent", "library"] as const)
  it.effect(`recovery stops on a changed ${changed} without overwriting it`, () =>
    Effect.gen(function* () {
      const f = yield* fixture("enable");
      const pending = yield* interrupt(f, "folder");
      if (changed === "parent") {
        yield* f.fs.rename(f.skills, `${f.skills}-original`);
        yield* f.fs.makeDirectory(f.skills);
      }
      if (changed === "skill" || changed === "parent") {
        yield* f.fs.makeDirectory(f.installed, { recursive: true });
        yield* f.fs.writeFileString(join(f.installed, "SKILL.md"), "User's new bytes\n");
      } else {
        const state = yield* loadLibrary(f.home);
        yield* saveLibrary(f.home, {
          ...state,
          pending_device_selection_origin: "https://changed.fixture",
        });
      }
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        assert.deepStrictEqual(library.startup.finished, []);
        assert.strictEqual(library.startup.stopped[0]?.operationId, pending.operationId);
        assert.strictEqual((yield* library.history).operations.at(-1)?._tag, "Stopped");
      }).pipe(Effect.provide(f.layer));
      if (changed !== "library")
        assert.strictEqual(
          yield* f.fs.readFileString(join(f.installed, "SKILL.md")),
          "User's new bytes\n",
        );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "a multi-skill apply resumes its remaining copy without changing either recorded identity",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture("enable");
      const secondSource = join(f.root, "second-source");
      yield* f.fs.makeDirectory(secondSource);
      yield* f.fs.writeFileString(
        join(secondSource, "SKILL.md"),
        "---\nname: second\ndescription: Second fixture\n---\nSecond bytes\n",
      );
      const plan = yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const request = yield* localImportRequest(secondSource, "2026-11-05T00:00:00.000Z");
        if (Option.isNone(request)) return yield* Effect.die("Missing second source");
        yield* library.import.collection(request.value);
        const snapshot = yield* library.read;
        if (snapshot._tag !== "Present") return yield* Effect.die("Missing Library");
        return yield* library.plan(
          {
            _tag: "Enabled",
            changes: [
              {
                _tag: "Enable",
                subject: { _tag: "Skill", id: snapshot.state.skills[0]!.skill_id },
                where: [{ kind: "global" }],
              },
              {
                _tag: "Enable",
                subject: { _tag: "Skill", id: snapshot.state.skills[1]!.skill_id },
                where: [{ kind: "global" }],
              },
            ],
          },
          { base: snapshot },
        );
      }).pipe(Effect.provide(f.layer));
      const operation = yield* interrupt({ ...f, plan }, "folder");
      const step = operation.steps[0]?.step;
      if (step?._tag !== "Apply") return yield* Effect.die("Missing recorded batch");
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        assert.deepStrictEqual(library.startup.finished, [operation.operationId]);
        const snapshot = yield* library.read;
        if (snapshot._tag !== "Present") return yield* Effect.die("Missing Library");
        assert.strictEqual(snapshot.state.installed_skills.length, 2);
        for (const copy of snapshot.state.installed_skills)
          assert.strictEqual(
            copy.installed_skill_id,
            step.changes
              .flatMap((change) =>
                change._tag === "Install" || change._tag === "Save" ? [change.row] : [],
              )
              .find((row) => row.path === copy.path)?.installed_skill_id,
          );
      }).pipe(Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })));
      assert.strictEqual(
        yield* f.fs.readFileString(join(f.skills, "second", "SKILL.md")),
        "---\nname: second\ndescription: Second fixture\n---\nSecond bytes\n",
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("recovery prepares a missing root from the recorded review", () =>
  Effect.gen(function* () {
    const f = yield* fixture("enable", true);
    const operation = yield* interrupt(f, "recorded");
    assert.isFalse(yield* f.fs.exists(f.skills));
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      assert.deepStrictEqual(library.startup.finished, [operation.operationId]);
      assert.deepStrictEqual(library.startup.stopped, []);
    }).pipe(Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })));
    assert.strictEqual(
      yield* f.fs.readFileString(join(f.installed, "SKILL.md")),
      bytes("Original"),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("apply returns the final journal revision and rebuilds the next state from intent", () =>
  Effect.gen(function* () {
    const f = yield* fixture("enable");
    // The plan's derived rows are display data, never authority to publish arbitrary state.
    f.plan.next.repositories.push({ root: join(f.root, "unreviewed"), enabled: [] });
    const operationReads = new Map<string, number>();
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const outcome = yield* library.apply({ _tag: "Apply", plan: f.plan }).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement, _sql, _fiber, span) =>
          Effect.sync(() => {
            if (
              statement
                .compile()[0]
                .startsWith("SELECT document FROM library_operations WHERE operation_id")
            ) {
              let parent = Option.getOrUndefined(span.parent);
              while (parent?._tag === "Span") {
                if (parent.name === "Library.saveOperation") {
                  operationReads.set(parent.spanId, (operationReads.get(parent.spanId) ?? 0) + 1);
                  break;
                }
                parent = Option.getOrUndefined(parent.parent);
              }
            }
            return statement;
          }),
        ),
      );
      assert.isAbove(operationReads.size, 0);
      assert.isTrue([...operationReads.values()].every((reads) => reads === 1));
      assert.strictEqual(outcome.result._tag, "Applied");
      const snapshot = yield* library.read;
      if (snapshot._tag !== "Present") return yield* Effect.die("Missing Library");
      assert.deepStrictEqual(snapshot.state.repositories, []);
      assert.strictEqual(outcome.result.results[0]?.revision, libraryStateRevision(snapshot.state));
      assert.deepStrictEqual(yield* loadOperations(f.home), []);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("recovery resumes after creating a previously absent skills directory", () =>
  Effect.gen(function* () {
    const f = yield* fixture("enable", true);
    const operation = yield* interrupt(f, "directory");
    assert.isTrue(yield* f.fs.exists(f.skills));
    assert.isFalse(yield* f.fs.exists(f.installed));
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      assert.deepStrictEqual(library.startup.finished, [operation.operationId]);
      assert.deepStrictEqual(library.startup.stopped, []);
      assert.strictEqual(
        yield* f.fs.readFileString(join(f.installed, "SKILL.md")),
        bytes("Original"),
      );
    }).pipe(Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("recovery settles predecessor backups after the completed state was committed", () =>
  Effect.gen(function* () {
    const f = yield* fixture("update");
    const operation = yield* interrupt(f, "settlement");
    const backups = join(f.root, ".skit-backups");
    assert.isTrue((yield* f.fs.readDirectory(backups)).some((name) => name.startsWith("pending-")));
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      assert.deepStrictEqual(library.startup.finished, [operation.operationId]);
      assert.deepStrictEqual(library.startup.stopped, []);
    }).pipe(Effect.provide(Library.layer({ home: f.home, roots: testRoots(f.home) })));
    assert.isFalse(
      (yield* f.fs.readDirectory(backups)).some((name) => name.startsWith("pending-")),
    );
    assert.strictEqual(yield* f.fs.readFileString(join(f.installed, "SKILL.md")), bytes("Updated"));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const failure of ["expected", "defect", "interrupt"] as const)
  it.effect(`backup settlement keeps expected failures pending and propagates ${failure}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture("update");
      yield* interrupt(f, "settlement");
      const backups = join(f.root, ".skit-backups");
      const defect = new Error("backup scan defect");
      let attempted = false;
      const fs: FileSystem.FileSystem = {
        ...f.fs,
        readDirectory: (path) => {
          if (path !== backups) return f.fs.readDirectory(path);
          attempted = true;
          return failure === "defect"
            ? Effect.die(defect)
            : failure === "interrupt"
              ? Effect.interrupt
              : Effect.fail(
                  systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readDirectory",
                    pathOrDescriptor: path,
                  }),
                );
        },
      };
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const library = yield* Library.Service;
          return yield* library.read;
        }).pipe(
          Effect.provide(f.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)))),
        ),
      );
      assert.isTrue(attempted);
      if (failure === "expected") assert.strictEqual(exit._tag, "Success");
      else {
        if (exit._tag !== "Failure") return assert.fail("settlement failure was swallowed");
        if (failure === "defect")
          assert.isTrue(
            exit.cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect === defect,
            ),
          );
        else assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      }
      // The successor was already published. Failure neither rolls it back nor drops its backup.
      assert.strictEqual(
        yield* f.fs.readFileString(join(f.installed, "SKILL.md")),
        bytes("Updated"),
      );
      assert.isTrue(
        (yield* f.fs.readDirectory(backups)).some((name) => name.startsWith("pending-")),
      );
      if (failure !== "expected") {
        yield* Effect.asVoid(Library.Service).pipe(Effect.provide(f.layer));
        assert.isFalse(
          (yield* f.fs.readDirectory(backups)).some((name) => name.startsWith("pending-")),
        );
      }
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("completed domain-changing Apply leaves no row and refuses the same reviewed plan", () =>
  Effect.gen(function* () {
    const f = yield* fixture("enable");
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      yield* library.apply({ _tag: "Apply", plan: f.plan });
      assert.deepStrictEqual(yield* loadOperations(f.home), []);
      const before = yield* library.read;
      const history = yield* library.history;
      const replay = yield* library.apply({ _tag: "Apply", plan: f.plan }).pipe(Effect.flip);
      assert.strictEqual(replay._tag, "Library.StalePlan");
      assert.deepStrictEqual(yield* library.read, before);
      assert.deepStrictEqual(yield* library.history, history);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("backup-only Apply settles once and a replay is a no-op without a tombstone", () =>
  Effect.gen(function* () {
    const f = yield* fixture("enable");
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      yield* library.apply({ _tag: "Apply", plan: f.plan });
      const before = yield* library.read;
      if (before._tag !== "Present") return yield* Effect.die("Missing installed state");
      const copy = before.state.installed_skills[0]!;
      // A recovered predecessor can remain pending beside an already-current installed copy.
      const backups = join(f.root, ".skit-backups");
      yield* f.fs.makeDirectory(backups);
      yield* f.fs.writeFileString(join(backups, ".gitignore"), "*\n");
      yield* f.fs.copy(
        copy.path,
        join(
          backups,
          `pending-${copy.installed_skill_id}-2026-11-05T00-00-00.000Z-replace-fixture`,
        ),
      );
      const plan = yield* library.plan({ _tag: "Update" }, { base: before });
      yield* library.apply({ _tag: "Apply", plan });
      assert.deepStrictEqual(yield* library.read, before);
      assert.deepStrictEqual(yield* pendingInstalledSkillBackups(copy), []);
      assert.deepStrictEqual(yield* loadOperations(f.home), []);
      const settled = yield* library.history;
      yield* library.apply({ _tag: "Apply", plan });
      assert.deepStrictEqual(yield* library.read, before);
      assert.deepStrictEqual(yield* library.history, settled);
      assert.deepStrictEqual(yield* loadOperations(f.home), []);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const boundary of ["folder", "settlement"] as const)
  it.effect(
    `Enabled replay after ${boundary} discards a reproducible backup using the previous policy`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture("enable");
        const plan = yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          if (f.plan.intent._tag !== "Enabled") return yield* Effect.die("Missing Enabled intent");
          yield* library.apply({
            _tag: "Apply",
            plan: yield* library.plan(
              {
                _tag: "Enabled",
                changes: [{ ...f.plan.intent.changes[0], invocation: "explicit" }],
              },
              { base: yield* library.read },
            ),
          });
          return yield* library.plan(
            { _tag: "Enabled", changes: [{ ...f.plan.intent.changes[0], invocation: "implicit" }] },
            { base: yield* library.read },
          );
        }).pipe(Effect.provide(f.layer));
        const before = yield* loadLibrary(f.home);
        const operation = yield* interrupt({ ...f, plan }, boundary);
        const step = operation.steps[0]?.step;
        if (step?._tag !== "Apply" || step.bodyChange?._tag !== "Enabled")
          return yield* Effect.die("Missing Enabled fields");
        const policy = step.bodyChange.fields.find(
          (field) => field.field === "invocation_policies",
        );
        assert.deepStrictEqual(policy?.before, before.invocation_policies);
        assert.notStrictEqual(JSON.stringify(policy?.before), JSON.stringify(policy?.after));
        const backups = join(f.root, ".skit-backups");
        assert.isTrue(
          (yield* f.fs.readDirectory(backups)).some((name) => name.startsWith("pending-")),
        );
        yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          assert.deepStrictEqual(library.startup.finished, [operation.operationId]);
          const after = yield* loadLibrary(f.home);
          assert.strictEqual(after.invocation_policies?.[after.skills[0]!.skill_id], "implicit");
        }).pipe(Effect.provide(f.layer));
        assert.deepStrictEqual(yield* f.fs.readDirectory(backups), [".gitignore"]);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("the store refuses an old pending Apply intact", () =>
  Effect.gen(function* () {
    const f = yield* fixture("enable");
    const pending = yield* interrupt(f, "recorded");
    const state = yield* loadLibrary(f.home);
    const old = {
      ...pending,
      steps: pending.steps.map((item) => ({
        ...item,
        step: {
          _tag: "Apply",
          before: state,
          next: f.plan.next,
          routing: item.step._tag === "Apply" ? item.step.routing : {},
          save: "before",
          enabled: [],
          folders: [],
          changes: [],
          phase: { _tag: "Pending" },
        },
      })),
    };
    const document = JSON.stringify(old);
    yield* withLibraryDatabase(
      libraryDatabasePath(f.home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE library_operations SET document = ${document} WHERE operation_id = ${pending.operationId}`;
      }),
    );
    const error = yield* loadOperations(f.home).pipe(Effect.flip);
    assert.strictEqual(error._tag, "InvalidLibraryState");
    if (error._tag === "InvalidLibraryState")
      assert.strictEqual(error.reason._tag, "SchemaInvalid");
    yield* withLibraryDatabase(
      libraryDatabasePath(f.home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          document: string;
        }>`SELECT document FROM library_operations WHERE operation_id = ${pending.operationId}`;
        assert.strictEqual(rows[0]?.document, document);
      }),
    );
    assert.deepStrictEqual(yield* loadLibrary(f.home), state);
    assert.isFalse(yield* f.fs.exists(f.installed));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Apply records stay small on the 575 KB Library fixture", () =>
  Effect.gen(function* () {
    const measurements = [];
    const { installed_skills: _installed, ...publication } = LibraryStateFields;
    const oldCopies = Schema.Struct({
      before: LibraryStateDocument,
      next: Schema.Struct(publication),
    });
    for (const operation of ["enable", "disable", "update", "remove"] as const) {
      const f = yield* fixture(operation);
      const { state: large } = yield* valuesFixture;
      const real = yield* loadLibrary(f.home);
      const before = {
        ...large,
        collections: [...large.collections, ...real.collections],
        skills: [...large.skills, ...real.skills],
        collection_versions: [...large.collection_versions, ...real.collection_versions],
        imports: [...large.imports, ...real.imports],
        enabled: real.enabled,
        installed_skills: [...large.installed_skills, ...real.installed_skills],
        invocation_policies: { ...large.invocation_policies, ...real.invocation_policies },
      };
      yield* saveLibrary(f.home, before);
      const plan = yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        return yield* library.plan(
          operation === "update"
            ? { _tag: "Update", skills: real.skills.map((skill) => skill.skill_id) }
            : f.plan.intent,
          { base: yield* library.read },
        );
      }).pipe(Effect.provide(f.layer));
      const { installed_skills: _rows, ...afterBody } = plan.next;
      const observed: Array<{
        step: number;
        oldStep: number;
        operation: number;
        oldOperation: number;
        row: number;
      }> = [];
      const fs: FileSystem.FileSystem = {
        ...f.fs,
        chmod: (path, mode) =>
          Effect.gen(function* () {
            yield* f.fs.chmod(path, mode);
            if (path !== libraryDatabasePath(f.home)) return;
            yield* withLibraryDatabase(
              path,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const rows = yield* sql<{
                  document: string;
                  bytes: number;
                }>`SELECT document, length(CAST(document AS BLOB)) AS bytes FROM library_operations`;
                for (const row of rows) {
                  const value = yield* Schema.decodeEffect(Schema.fromJsonString(OperationStatus))(
                    row.document,
                  );
                  if (value._tag !== "Pending") continue;
                  const step = value.steps[0]?.step;
                  if (step?._tag !== "Apply") continue;
                  const encodedStep = yield* Schema.encodeEffect(InstalledApply)(step);
                  const encodedOperation = yield* Schema.encodeEffect(OperationStatus)(value);
                  const {
                    beforeHash: _beforeHash,
                    afterHash: _afterHash,
                    previousInstalledSkills: _previous,
                    bodyChange: _change,
                    ...rest
                  } = encodedStep;
                  const oldStep = {
                    ...rest,
                    ...(yield* Schema.encodeEffect(oldCopies)({ before, next: afterBody })),
                  };
                  const oldOperation = {
                    ...encodedOperation,
                    steps: encodedOperation.steps.map((item, index) =>
                      index === 0 ? { ...item, step: oldStep } : item,
                    ),
                  };
                  observed.push({
                    step: Buffer.byteLength(JSON.stringify(encodedStep)),
                    oldStep: Buffer.byteLength(JSON.stringify(oldStep)),
                    operation: Buffer.byteLength(row.document),
                    oldOperation: Buffer.byteLength(JSON.stringify(oldOperation)),
                    row: row.bytes,
                  });
                }
              }),
            ).pipe(Effect.provideService(FileSystem.FileSystem, f.fs), Effect.orDie);
          }),
      };
      const result = yield* Effect.flatMap(Library.Service, (library) =>
        library.apply({ _tag: "Apply", plan }),
      ).pipe(Effect.provide(f.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)))));
      assert.strictEqual(result.result._tag, "Applied");
      assert.isAbove(observed.length, 0);
      const first = observed[0]!;
      assert.isBelow(first.step, first.oldStep / 10);
      measurements.push({
        intent: operation,
        fixtureBytes: Buffer.byteLength(JSON.stringify(large)),
        liveBytes: Buffer.byteLength(JSON.stringify(before)),
        first,
        largest: {
          step: Math.max(...observed.map((item) => item.step)),
          oldStep: Math.max(...observed.map((item) => item.oldStep)),
          operation: Math.max(...observed.map((item) => item.operation)),
          oldOperation: Math.max(...observed.map((item) => item.oldOperation)),
          row: Math.max(...observed.map((item) => item.row)),
        },
      });
    }
    yield* (yield* FileSystem.FileSystem).writeFileString(
      "/private/tmp/skit-apply-record-sizes.json",
      JSON.stringify(measurements, null, 2),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an unverifiable prior body keeps a completed Apply backup with its bytes", () =>
  Effect.gen(function* () {
    const f = yield* fixture("update");
    const operation = yield* interrupt(f, "settlement");
    const changed = {
      ...operation,
      steps: operation.steps.map((item) =>
        item.step._tag === "Apply"
          ? { ...item, step: { ...item.step, beforeHash: "sha256:" + "0".repeat(64) } }
          : item,
      ),
    };
    const document = yield* Schema.encodeEffect(Schema.fromJsonString(OperationStatus))(changed);
    yield* withLibraryDatabase(
      libraryDatabasePath(f.home),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE library_operations SET document = ${document} WHERE operation_id = ${operation.operationId}`;
      }),
    );
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      assert.deepStrictEqual(library.startup.finished, [operation.operationId]);
    }).pipe(Effect.provide(f.layer));
    const backups = join(f.root, ".skit-backups");
    const kept = (yield* f.fs.readDirectory(backups)).find((name) => name.startsWith("kept-"));
    assert.ok(kept);
    assert.strictEqual(
      yield* f.fs.readFileString(join(backups, kept, "SKILL.md")),
      bytes("Original"),
    );
    assert.strictEqual(yield* f.fs.readFileString(join(f.installed, "SKILL.md")), bytes("Updated"));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an invalid retained source produces and records a valid unchanged Apply fallback", () =>
  Effect.gen(function* () {
    const f = yield* fixture("disable");
    const before = yield* loadLibrary(f.home);
    const skill = before.skills[0];
    assert.ok(skill);
    const version = currentSkillVersion(before, skill);
    assert.ok(version);
    const backing = versionBacking(before, skill, version);
    assert.ok(backing);
    yield* f.fs.writeFileString(
      join(
        collectionVersionPath(join(f.home, "originals"), backing.copy.hash),
        backing.member.source_path,
        "SKILL.md",
      ),
      "tampered retained bytes\n",
    );
    const skills = join(f.root, "new-skills");
    const layer = Library.layer({
      home: f.home,
      roots: { home: f.root, configHome: f.root, overrides: { codex: [skills] } },
    });
    const plan = yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      return yield* library.plan({ _tag: "Install" }, { base: yield* library.read });
    }).pipe(Effect.provide(layer));
    const operation = yield* interrupt(
      { ...f, skills, installed: join(skills, "review"), layer, plan },
      "recorded",
    );
    const step = operation.steps[0]?.step;
    if (step?._tag !== "Apply") return assert.fail("Missing recorded Apply");
    assert.isTrue(Schema.is(InstalledApply)(step));
    assert.isFalse(Object.hasOwn(step, "bodyChange"));
    assert.strictEqual(step.afterHash, step.beforeHash);
    assert.strictEqual(step.save, "after");
    assert.strictEqual(step.changes[0]?._tag, "Fail");
    assert.deepStrictEqual(yield* loadLibrary(f.home), before);
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      assert.deepStrictEqual(library.startup.finished, []);
      assert.strictEqual(library.startup.stopped[0]?.operationId, operation.operationId);
    }).pipe(Effect.provide(f.layer));
    assert.deepStrictEqual(yield* loadLibrary(f.home), before);
    assert.strictEqual(
      yield* f.fs.readFileString(join(f.installed, "SKILL.md")),
      bytes("Original"),
    );
    assert.strictEqual((yield* loadOperations(f.home)).at(-1)?._tag, "Stopped");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
