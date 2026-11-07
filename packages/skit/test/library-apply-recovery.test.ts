import { assert, it } from "@effect/vitest";
import { Cause, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { systemError } from "effect/PlatformError";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { LibraryState, libraryStateRevision } from "../src/library/library-state.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";

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
  const read = Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryState));
  return { fs, root, home, source, skills, installed, layer, plan, read };
});

const interrupt = Effect.fn("test.applyRecovery.interrupt")(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  boundary: Boundary,
) {
  let crashed = false;
  const fs: FileSystem.FileSystem = {
    ...f.fs,
    makeDirectory: (path, options) =>
      Effect.gen(function* () {
        yield* f.fs.makeDirectory(path, options);
        if (!crashed && boundary === "directory" && path === f.skills) {
          crashed = true;
          return yield* Effect.die("Process exited after creating skills directory");
        }
      }),
    rename: (from, to) =>
      Effect.gen(function* () {
        if (!crashed && to === join(f.home, "state.json")) {
          const next = yield* f.read(yield* f.fs.readFileString(from)).pipe(Effect.orDie);
          const operation = next.operations.at(-1);
          const step = operation?.steps[0];
          if (operation?._tag === "Pending" && step?.step._tag === "Apply") {
            if (boundary === "recorded" && step.step.phase._tag === "Pending") {
              yield* f.fs.rename(from, to);
              crashed = true;
              return yield* Effect.die("Process exited after recording apply");
            }
            if (boundary === "settlement" && step.step.phase._tag === "Done") {
              yield* f.fs.rename(from, to);
              crashed = true;
              return yield* Effect.die(
                "Process exited after state commit before backup settlement",
              );
            }
            if (boundary === "completion" && step.status === "Done") {
              crashed = true;
              return yield* Effect.die("Process exited before recording step completion");
            }
          }
        }
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
  const state = yield* f.read(yield* f.fs.readFileString(join(f.home, "state.json")));
  const operation = state.operations.at(-1);
  assert.strictEqual(operation?._tag, "Pending");
  if (!operation) return yield* Effect.die("Missing durable operation");
  return yield* Schema.decodeUnknownEffect(OperationStatus)(operation);
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
        assert.isFalse(Object.hasOwn(saved.next, "operations"));
        assert.isFalse(Object.hasOwn(saved.next, "installed_skills"));
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
        const state = yield* f.read(yield* f.fs.readFileString(join(f.home, "state.json")));
        yield* f.fs.writeFileString(
          join(f.home, "state.json"),
          JSON.stringify({ ...state, pending_device_selection_origin: "https://changed.fixture" }),
        );
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
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const outcome = yield* library.apply({ _tag: "Apply", plan: f.plan });
      assert.strictEqual(outcome.result._tag, "Applied");
      const snapshot = yield* library.read;
      if (snapshot._tag !== "Present") return yield* Effect.die("Missing Library");
      assert.deepStrictEqual(snapshot.state.repositories, []);
      assert.strictEqual(outcome.result.results[0]?.revision, libraryStateRevision(snapshot.state));
      assert.strictEqual(snapshot.state.operations.at(-1)?._tag, "Done");
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
        yield* Effect.gen(function* () {
          yield* Library.Service;
        }).pipe(Effect.provide(f.layer));
        assert.isFalse(
          (yield* f.fs.readDirectory(backups)).some((name) => name.startsWith("pending-")),
        );
      }
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
