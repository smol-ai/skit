import { assert, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { makeMachineId } from "../src/library/entity-ids.js";
import { observePathEvidence } from "../src/library/folder-evidence.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";
import { systemError } from "effect/PlatformError";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "skit-manage-owner-" }),
  );
  const home = join(root, "library");
  const agents = join(root, "agents");
  const copy = join(agents, "review");
  const bytes = "---\nname: review\ndescription: Manage fixture\n---\nExact reviewed bytes.\n";
  yield* fs.makeDirectory(copy, { recursive: true });
  yield* fs.writeFileString(join(copy, "SKILL.md"), bytes);
  const observed = yield* observePathEvidence(copy);
  if (Option.isNone(observed) || observed.value._tag !== "Directory")
    return yield* Effect.die("Expected reviewed folder");
  const source = observed.value;
  const request = yield* localImportRequest(copy, "2026-11-04T00:00:00.000Z");
  if (Option.isNone(request)) return yield* Effect.die("Expected import request");
  const intent: Library.ManageIntent = {
    _tag: "Manage",
    mode: "new",
    selections: [
      {
        name: "review",
        mode: "new",
        source,
        currentHash: Option.some(source.treeHash),
        importFrom: { _tag: "Import", request: request.value },
        equalCopies: [],
        duplicates: Option.none(),
        approvedCopies: [],
        approvedSymlinks: [],
        ownership: Option.some({ harnesses: ["codex"], machineId: Option.some(makeMachineId()) }),
      },
    ],
  };
  const config: Library.Config = {
    home,
    routing: {
      _tag: "Configured",
      home: root,
      configHome: join(root, "config"),
      overrides: { codex: [agents] },
    },
  };
  return { fs, root, home, agents, copy, source, bytes, intent, request: request.value, config };
});
const portable = (plan: Library.ManagePlan) => {
  const codec = Schema.fromJsonString(Library.ManagePlan);
  return Schema.encodeEffect(codec)(plan).pipe(Effect.flatMap(Schema.decodeUnknownEffect(codec)));
};

it.effect(
  "new Manage previews are passive and portable; import evidence and ownership are one recorded action",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const plan = yield* library.plan(f.intent, { base: yield* library.read });
        assert.isFalse(yield* f.fs.exists(f.home));
        assert.isFalse(yield* f.fs.exists(join(f.copy, ".skit-ownership.json")));
        assert.isTrue(Option.isNone(plan.change.selections[0].enable));
        const decoded = yield* portable(plan);
        const outcome = yield* library.apply({ _tag: "Apply", plan: decoded });
        assert.strictEqual(outcome.result.imported.length, 1);
        assert.strictEqual(outcome.result.results[0].application.status, "complete");
        assert.strictEqual(yield* f.fs.readFileString(join(f.copy, "SKILL.md")), f.bytes);
        assert.isTrue(yield* f.fs.exists(join(f.copy, ".skit-ownership.json")));
        const history = yield* library.history;
        assert.strictEqual(history.events.length, 1);
        assert.strictEqual(history.operations.length, 1);
        assert.strictEqual(history.operations[0]._tag, "Done");
        assert.strictEqual(history.operations[0].steps[0].step._tag, "Import");
        assert.strictEqual(history.operations[0].steps[0].after[0]._tag, "Retained");
        assert.strictEqual(history.operations[0].steps[1].step._tag, "Manage");
      }).pipe(Effect.provide(Library.layer(f.config)));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "existing Manage previews preserve unknown state and take ownership without changing Skill bytes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const imported = yield* library.import.collection(f.request);
        const statePath = join(f.home, "state.json");
        const saved = JSON.parse(yield* f.fs.readFileString(statePath));
        yield* f.fs.writeFileString(
          statePath,
          JSON.stringify({ ...saved, future: { keep: "future data" } }),
        );
        const before = yield* f.fs.readFileString(statePath);
        const plan = yield* library.plan(
          {
            _tag: "Manage",
            mode: "existing",
            selections: [
              {
                mode: "existing",
                name: "review",
                source: f.source,
                subjectId: imported.skills[0].skill_id,
                currentHash: f.source.treeHash,
                duplicates: Option.none(),
                approvedCopies: [],
                approvedSymlinks: [],
              },
            ],
          },
          { base: yield* library.read },
        );
        assert.isTrue(Option.isSome(plan.change.selections[0].enable));
        assert.strictEqual(yield* f.fs.readFileString(statePath), before);
        const outcome = yield* library.apply({ _tag: "Apply", plan: yield* portable(plan) });
        assert.strictEqual(outcome.result.imported.length, 0);
        assert.strictEqual(outcome.result.results.length, 1);
        assert.strictEqual(outcome.result.results[0].application.status, "complete");
        assert.strictEqual(yield* f.fs.readFileString(join(f.copy, "SKILL.md")), f.bytes);
        const after = JSON.parse(yield* f.fs.readFileString(statePath));
        assert.deepStrictEqual(after.future, { keep: "future data" });
        assert.strictEqual(after.installed_skills[0].status, "installed");
      }).pipe(Effect.provide(Library.layer(f.config)));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("retaining alone uses no routing and keeps previous completed setups undoable", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const previous = yield* library.setup([], { base: yield* library.read });
      const intent: Library.ManageIntent = {
        _tag: "Manage",
        mode: "new",
        selections: [
          {
            ...f.intent.selections[0],
            mode: "new",
            importFrom: { _tag: "Import", request: f.request },
            currentHash: Option.some(f.source.treeHash),
            equalCopies: [],
            duplicates: Option.some("retain-only"),
            ownership: Option.none(),
          },
        ],
      };
      const plan = yield* library.plan(intent, { base: yield* library.read });
      const result = (yield* library.apply({ _tag: "Apply", plan: yield* portable(plan) })).result;
      assert.strictEqual(result.imported.length, 1);
      assert.deepStrictEqual(result.results, []);
      assert.isFalse(yield* f.fs.exists(join(f.copy, ".skit-ownership.json")));
      const history = yield* library.history;
      assert.isTrue(
        history.operations.some((operation) => operation.operationId === previous.operationId),
      );
      assert.strictEqual(history.operations.length, 2);
      const undo = yield* library.plan(
        { _tag: "Undo", operationId: plan.operationId },
        { base: yield* library.read },
      );
      assert.strictEqual(undo.change.status, "ready");
    }).pipe(Effect.provide(Library.layer({ home: f.home, routing: { _tag: "None" } })));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

for (const edit of [false, true])
  it.effect(
    `interrupted Manage ${edit ? "stops on divergent bytes" : "resumes only recorded work on restart"}`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const stopped = yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          const plan = yield* library.plan(f.intent, { base: yield* library.read });
          const result = yield* Effect.exit(library.apply({ _tag: "Apply", plan: plan }));
          assert.isTrue(Exit.isFailure(result));
          return plan.operationId;
        }).pipe(
          Effect.provide(Library.layer(f.config)),
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            rename: (from, to) =>
              to === join(f.copy, ".skit-ownership.json")
                ? Effect.die("simulated process loss")
                : f.fs.rename(from, to),
            link: (from, to) =>
              to === join(f.copy, ".skit-ownership.json")
                ? Effect.die("simulated process loss")
                : f.fs.link(from, to),
          }),
        );
        const state = JSON.parse(yield* f.fs.readFileString(join(f.home, "state.json")));
        assert.strictEqual(state.operations[0]._tag, "Pending");
        assert.strictEqual(state.operations[0].steps[0].status, "Done");
        assert.strictEqual(state.operations[0].steps[1].status, "Pending");
        if (edit) yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), "operator changed bytes\n");
        yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          if (edit) {
            assert.strictEqual(library.startup.stopped[0].operationId, stopped);
            assert.strictEqual(library.startup.stopped[0].reason._tag, "EvidenceDiffers");
            assert.strictEqual(
              yield* f.fs.readFileString(join(f.copy, "SKILL.md")),
              "operator changed bytes\n",
            );
          } else {
            assert.deepStrictEqual(library.startup.finished, [stopped]);
            assert.strictEqual(yield* f.fs.readFileString(join(f.copy, "SKILL.md")), f.bytes);
            assert.isTrue(yield* f.fs.exists(join(f.copy, ".skit-ownership.json")));
            assert.strictEqual((yield* library.history).operations[0]._tag, "Done");
          }
        }).pipe(Effect.provide(Library.layer({ home: f.home, routing: { _tag: "None" } })));
      }).pipe(Effect.scoped, Effect.provide(skitLayer)),
  );

it.effect("changed folders, altered plans and another Library are refused before recording", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const plan = yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const plan = yield* library.plan(f.intent, { base: yield* library.read });
      const altered = yield* Effect.result(
        library.apply({
          _tag: "Apply",
          plan: { ...plan, change: { ...plan.change, selections: [] } },
        }),
      );
      assert.strictEqual(altered._tag, "Failure");
      if (altered._tag === "Failure") assert.strictEqual(altered.failure._tag, "Library.StalePlan");
      yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), "operator edit\n");
      const stale = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
      assert.strictEqual(stale._tag, "Failure");
      if (stale._tag === "Failure") assert.strictEqual(stale.failure._tag, "Library.StalePlan");
      assert.isFalse(yield* f.fs.exists(join(f.home, "state.json")));
      yield* f.fs.writeFileString(join(f.copy, "SKILL.md"), f.bytes);
      return plan;
    }).pipe(Effect.provide(Library.layer(f.config)));
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const refused = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
      assert.strictEqual(refused._tag, "Failure");
      if (refused._tag === "Failure") assert.strictEqual(refused.failure._tag, "Library.StalePlan");
      assert.isFalse(yield* f.fs.exists(join(f.root, "other-library", "state.json")));
    }).pipe(Effect.provide(Library.layer({ ...f.config, home: join(f.root, "other-library") })));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "failure to publish the before-record writes no imported content or ownership marker",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const plan = yield* library.plan(f.intent, { base: yield* library.read });
        const result = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "PlatformError");
        assert.isFalse(yield* f.fs.exists(join(f.home, "state.json")));
        assert.isFalse(yield* f.fs.exists(join(f.home, "originals")));
        assert.isFalse(yield* f.fs.exists(join(f.copy, ".skit-ownership.json")));
        assert.strictEqual(yield* f.fs.readFileString(join(f.copy, "SKILL.md")), f.bytes);
      }).pipe(
        Effect.provide(Library.layer(f.config)),
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          rename: (from, to) =>
            to === join(f.home, "state.json")
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
      );
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

for (const readable of [true, false])
  it.effect(
    `approved duplicates ${readable ? "move to the previewed recovery directory" : "stay when their harness cannot read the replacement"}`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const legacy = join(f.root, "opencode-skills");
        const duplicate = join(legacy, "review");
        yield* f.fs.makeDirectory(duplicate, { recursive: true });
        yield* f.fs.writeFileString(join(duplicate, "SKILL.md"), f.bytes);
        const observed = yield* observePathEvidence(duplicate);
        if (Option.isNone(observed) || observed.value._tag !== "Directory")
          return yield* Effect.die("Expected duplicate");
        const copy = observed.value;
        const intent: Library.ManageIntent = {
          _tag: "Manage",
          mode: "new",
          selections: [
            {
              ...f.intent.selections[0],
              mode: "new",
              importFrom: { _tag: "Import", request: f.request },
              currentHash: Option.some(f.source.treeHash),
              equalCopies: [],
              ownership: Option.some({
                harnesses: ["codex"],
                machineId: Option.some(makeMachineId()),
              }),
              duplicates: Option.some("preserve-duplicates"),
              approvedCopies: [copy],
            },
          ],
        };
        const config: Library.Config = {
          home: f.home,
          routing: {
            _tag: "Configured",
            home: f.root,
            configHome: join(f.root, "config"),
            overrides: { codex: [f.agents], opencode: readable ? [f.agents, legacy] : [legacy] },
          },
        };
        yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          const plan = yield* library.plan(intent, { base: yield* library.read });
          const backup = plan.change.selections[0].backup;
          if (Option.isNone(backup)) return yield* Effect.die("Expected backup preview");
          assert.isFalse(yield* f.fs.exists(backup.value.recoveryDirectory));
          assert.strictEqual(yield* f.fs.readFileString(join(duplicate, "SKILL.md")), f.bytes);
          const outcome = yield* library.apply({ _tag: "Apply", plan: yield* portable(plan) });
          if (readable) {
            assert.deepStrictEqual(outcome.result.recoveryDirectories, [
              backup.value.recoveryDirectory,
            ]);
            assert.isFalse(yield* f.fs.exists(duplicate));
            assert.strictEqual(
              yield* f.fs.readFileString(
                join(backup.value.recoveryDirectory, "1-review", "SKILL.md"),
              ),
              f.bytes,
            );
          } else {
            assert.deepStrictEqual(outcome.result.recoveryDirectories, []);
            assert.isTrue(
              outcome.result.warnings.some((warning) =>
                warning.message.includes("no active replacement is readable"),
              ),
            );
            assert.isFalse(yield* f.fs.exists(backup.value.recoveryDirectory));
            assert.strictEqual(yield* f.fs.readFileString(join(duplicate, "SKILL.md")), f.bytes);
          }
          assert.strictEqual(yield* f.fs.readFileString(join(f.copy, "SKILL.md")), f.bytes);
          assert.isTrue(yield* f.fs.exists(join(f.copy, ".skit-ownership.json")));
        }).pipe(Effect.provide(Library.layer(config)));
      }).pipe(Effect.scoped, Effect.provide(skitLayer)),
  );

it.effect(
  "a failure after recording returns the operation id and leaves completed imports inspectable",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const plan = yield* library.plan(f.intent, { base: yield* library.read });
        const result = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.strictEqual(result.failure._tag, "Library.ManageStopped");
          if (result.failure._tag === "Library.ManageStopped")
            assert.strictEqual(result.failure.operationId, plan.operationId);
        }
        const history = yield* library.history;
        assert.strictEqual(history.operations[0].operationId, plan.operationId);
        assert.strictEqual(history.operations[0]._tag, "Stopped");
        assert.strictEqual(history.operations[0].steps[0].status, "Done");
        const snapshot = yield* library.read;
        if (snapshot._tag === "Absent") return yield* Effect.die("Expected saved import");
        assert.strictEqual(snapshot.state.collections.length, 1);
        assert.strictEqual(yield* f.fs.readFileString(join(f.copy, "SKILL.md")), f.bytes);
      }).pipe(
        Effect.provide(Library.layer(f.config)),
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          rename: (from, to) =>
            to === join(f.copy, ".skit-ownership.json")
              ? Effect.fail(
                  systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: to,
                  }),
                )
              : f.fs.rename(from, to),
          link: (from, to) =>
            to === join(f.copy, ".skit-ownership.json")
              ? Effect.fail(
                  systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "link",
                    pathOrDescriptor: to,
                  }),
                )
              : f.fs.link(from, to),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "partial destinations keep the managed copy and report incomplete application details",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const claude = join(f.root, "claude-skills");
      const other = join(claude, "review", "SKILL.md");
      const otherBytes =
        "---\nname: review\ndescription: Operator copy\n---\nIrreplaceable operator bytes.\n";
      yield* f.fs.makeDirectory(join(claude, "review"), { recursive: true });
      yield* f.fs.writeFileString(other, otherBytes);
      const config: Library.Config = {
        home: f.home,
        routing: {
          _tag: "Configured",
          home: f.root,
          configHome: join(f.root, "config"),
          overrides: { codex: [f.agents], "claude-code": [claude] },
        },
      };
      const intent: Library.ManageIntent = {
        _tag: "Manage",
        mode: "new",
        selections: [
          {
            ...f.intent.selections[0],
            mode: "new",
            importFrom: { _tag: "Import", request: f.request },
            currentHash: Option.some(f.source.treeHash),
            equalCopies: [],
            ownership: Option.some({
              harnesses: ["codex"],
              machineId: Option.some(makeMachineId()),
            }),
            duplicates: Option.some("keep-both"),
          },
        ],
      };
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const plan = yield* library.plan(intent, { base: yield* library.read });
        const result = (yield* library.apply({ _tag: "Apply", plan: plan })).result;
        assert.isTrue(result.warnings.length > 0);
        assert.strictEqual(result.results[0].application.status, "incomplete");
        assert.ok(result.results[0].application.failure);
        assert.strictEqual(yield* f.fs.readFileString(join(f.copy, "SKILL.md")), f.bytes);
        assert.isTrue(yield* f.fs.exists(join(f.copy, ".skit-ownership.json")));
        assert.strictEqual(yield* f.fs.readFileString(other), otherBytes);
        assert.isFalse(yield* f.fs.exists(join(claude, "review", ".skit-ownership.json")));
        assert.strictEqual((yield* library.history).operations[0]._tag, "Done");
      }).pipe(Effect.provide(Library.layer(config)));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("a newly introduced duplicate invalidates Manage without moving either copy", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const legacy = join(f.root, "opencode-skills");
    yield* f.fs.makeDirectory(legacy);
    const config: Library.Config = {
      home: f.home,
      routing: {
        _tag: "Configured",
        home: f.root,
        configHome: join(f.root, "config"),
        overrides: { codex: [f.agents], opencode: [legacy] },
      },
    };
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const plan = yield* library.plan(f.intent, { base: yield* library.read });
      const duplicate = join(legacy, "review");
      yield* f.fs.makeDirectory(duplicate);
      yield* f.fs.writeFileString(join(duplicate, "SKILL.md"), f.bytes);
      const result = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "Library.StalePlan");
      assert.isFalse(yield* f.fs.exists(join(f.home, "state.json")));
      assert.strictEqual(yield* f.fs.readFileString(join(duplicate, "SKILL.md")), f.bytes);
      assert.strictEqual(yield* f.fs.readFileString(join(f.copy, "SKILL.md")), f.bytes);
    }).pipe(Effect.provide(Library.layer(config)));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
