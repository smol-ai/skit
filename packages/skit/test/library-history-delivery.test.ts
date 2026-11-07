import { assert, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Schema } from "effect";
import { join } from "node:path";
import { systemError } from "effect/PlatformError";
import * as Library from "../src/library/library.js";
import { LibraryState } from "../src/library/library-state.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { StateEnvelope } from "../src/library/store/history-delivery.js";
import {
  inspectLocalLibraryState,
  writeLibrary,
  LibraryWriter,
  recoverLibraryHistory,
} from "../src/library/store/library-store.js";
import { snapshotOf } from "../src/library/snapshot.js";
import { skitLayer } from "../src/platform/layer.js";
import { acquireFileLock } from "../src/platform/file-lock.js";
import { deliverLibraryHistory } from "../src/library/store/state-file.js";

const readEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(StateEnvelope));
const fixture = Effect.fn("test.historyDelivery.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "skit-history-delivery-" }),
  );
  const home = join(root, "home");
  const source = join(root, "source");
  const skills = join(root, "skills");
  yield* fs.makeDirectory(source);
  yield* fs.makeDirectory(skills);
  yield* fs.writeFileString(
    join(source, "SKILL.md"),
    "---\nname: review\ndescription: review\n---\nOriginal\n",
  );
  const request = yield* localImportRequest(source, "2026-11-05T00:00:00.000Z");
  if (Option.isNone(request)) return yield* Effect.die("Missing fixture source");
  const layer = Library.layer({
    home,
    roots: { home: root, configHome: root, overrides: { codex: [skills] } },
  });
  return {
    fs,
    home,
    source,
    skills,
    request: request.value,
    layer,
    statePath: join(home, "state.json"),
    logPath: join(home, "audit.jsonl"),
  };
});

for (const delivery of ["absent", "empty"] as const)
  it.effect(
    `opens a Library with ${delivery} history delivery while another holder owns its lock`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.flatMap(Library.Service, (owner) => owner.import.collection(f.request)).pipe(
          Effect.provide(f.layer),
        );
        if (delivery === "empty") {
          const state = yield* readEnvelope(yield* f.fs.readFileString(f.statePath));
          yield* f.fs.writeFileString(
            f.statePath,
            JSON.stringify({ ...state, historyDelivery: { schemaVersion: 1, pending: [] } }),
          );
        }
        const state = yield* f.fs.readFileString(f.statePath);
        const audit = yield* f.fs.readFileString(f.logPath);
        // A native hold supplies no reentrant HomeLock authority to the Library.
        yield* acquireFileLock(join(f.home, "lock.sqlite"));
        yield* deliverLibraryHistory(f.home);
        yield* Effect.gen(function* () {
          const owner = yield* Library.Service;
          assert.strictEqual((yield* owner.read)._tag, "Present");
          assert.strictEqual((yield* owner.history).events.length, 1);
        }).pipe(Effect.provide(f.layer));
        assert.strictEqual(
          (yield* Effect.flip(writeLibrary(f.home, Effect.void)))._tag,
          "HomeBusy",
        );
        assert.strictEqual(yield* f.fs.readFileString(f.statePath), state);
        assert.strictEqual(yield* f.fs.readFileString(f.logPath), audit);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "queued history still requires the writer and delivers after its holder releases it",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const event = yield* Effect.gen(function* () {
        const owner = yield* Library.Service;
        yield* owner.import.collection(f.request);
        return (yield* owner.history).events[0];
      }).pipe(Effect.provide(f.layer));
      const state = yield* readEnvelope(yield* f.fs.readFileString(f.statePath));
      const queued = JSON.stringify({
        ...state,
        historyDelivery: { schemaVersion: 1, pending: [{ event, operationIds: [] }] },
      });
      yield* f.fs.writeFileString(f.statePath, queued);
      yield* f.fs.writeFileString(f.logPath, "");
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireFileLock(join(f.home, "lock.sqlite"));
          assert.strictEqual((yield* Effect.flip(deliverLibraryHistory(f.home)))._tag, "HomeBusy");
          assert.strictEqual(yield* f.fs.readFileString(f.statePath), queued);
          assert.strictEqual(yield* f.fs.readFileString(f.logPath), "");
        }),
      );
      yield* deliverLibraryHistory(f.home);
      assert.isUndefined(
        (yield* readEnvelope(yield* f.fs.readFileString(f.statePath))).historyDelivery,
      );
      yield* Effect.gen(function* () {
        const owner = yield* Library.Service;
        assert.deepStrictEqual((yield* owner.history).events, [event]);
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const boundary of ["state", "before-log", "after-log", "after-ack"] as const)
  it.effect(`delivers one history event after interruption at ${boundary}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let interrupted = false;
      const files: FileSystem.FileSystem = {
        ...f.fs,
        rename: (from, to) =>
          Effect.gen(function* () {
            if (to === f.logPath && (boundary === "before-log" || boundary === "state")) {
              interrupted = true;
              return yield* Effect.die("Process exited before audit publication");
            }
            const stored =
              to === f.statePath
                ? yield* readEnvelope(yield* f.fs.readFileString(from)).pipe(Effect.orDie)
                : undefined;
            yield* f.fs.rename(from, to);
            if (
              boundary === "state" &&
              stored?.historyDelivery?.pending.some((item) => item.event.changes.length)
            ) {
              interrupted = true;
              return yield* Effect.die("Process exited after state publication");
            }
            if (boundary === "after-log" && to === f.logPath) {
              interrupted = true;
              return yield* Effect.die("Process exited after audit publication");
            }
            if (
              boundary === "after-ack" &&
              stored &&
              !stored.historyDelivery &&
              (yield* f.fs.exists(f.logPath))
            ) {
              interrupted = true;
              return yield* Effect.die("Process exited after audit acknowledgement");
            }
          }),
      };
      const owner = yield* Effect.flatMap(Library.Service, Effect.succeed).pipe(
        Effect.provide(f.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, files)))),
      );
      const outcome = yield* Effect.exit(owner.import.collection(f.request));
      assert.strictEqual(outcome._tag, "Failure");
      if (Exit.isFailure(outcome)) assert.isTrue(Cause.hasDies(outcome.cause));
      assert.isTrue(interrupted);
      const beforeText = yield* f.fs.readFileString(f.statePath);
      const before = snapshotOf(yield* inspectLocalLibraryState(f.home));
      assert.strictEqual(before._tag, "Present");
      // Passive reads do not deliver or acknowledge, and expose no private storage metadata.
      const passive = yield* owner.read;
      assert.strictEqual(passive.revision, before.revision);
      if (passive._tag === "Present")
        assert.isFalse(Object.hasOwn(passive.state, "historyDelivery"));
      assert.strictEqual(yield* f.fs.readFileString(f.statePath), beforeText);
      const queued = (yield* readEnvelope(beforeText)).historyDelivery?.pending[0]?.event;
      for (let attempt = 0; attempt < 2; attempt++)
        yield* Effect.gen(function* () {
          const recovered = yield* Library.Service;
          assert.strictEqual((yield* recovered.read).revision, before.revision);
          const events = (yield* recovered.history).events;
          assert.strictEqual(events.length, 1);
          if (queued) assert.strictEqual(events[0]?.eventId, queued.eventId);
          assert.strictEqual(events[0]?.changes[0]?.action, "added");
          assert.isUndefined(
            (yield* readEnvelope(yield* f.fs.readFileString(f.statePath))).historyDelivery,
          );
        }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("resumes a Pending operation into its original action event", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const plan = yield* Effect.gen(function* () {
      const owner = yield* Library.Service;
      const imported = yield* owner.import.collection(f.request);
      return yield* owner.plan(
        {
          _tag: "Enabled",
          changes: [
            {
              _tag: "Enable",
              subject: { _tag: "Skill", id: imported.skills[0]!.skill_id },
              where: [{ kind: "global" }],
            },
          ],
        },
        { base: yield* owner.read },
      );
    }).pipe(Effect.provide(f.layer));
    let interrupted = false;
    const files: FileSystem.FileSystem = {
      ...f.fs,
      rename: (from, to) =>
        Effect.gen(function* () {
          const next =
            to === f.statePath
              ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryState))(
                  yield* f.fs.readFileString(from),
                ).pipe(Effect.orDie)
              : undefined;
          yield* f.fs.rename(from, to);
          if (
            !interrupted &&
            next?.enabled.length &&
            next.operations.some((item) => item._tag === "Pending")
          ) {
            interrupted = true;
            return yield* Effect.die("Process exited during recorded Enable");
          }
        }),
    };
    const exit = yield* Effect.exit(
      Effect.flatMap(Library.Service, (owner) => owner.apply({ _tag: "Apply", plan: plan })).pipe(
        Effect.annotateLogs({ "skit.library.workflow": "test-apply" }),
        Effect.provide(f.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, files)))),
      ),
    );
    assert.strictEqual(exit._tag, "Failure");
    assert.isTrue(interrupted);
    const queue = (yield* readEnvelope(yield* f.fs.readFileString(f.statePath))).historyDelivery;
    assert.strictEqual(queue?.pending.length, 1);
    const expected = queue?.pending[0]?.event;
    yield* Effect.gen(function* () {
      const owner = yield* Library.Service;
      assert.strictEqual(owner.startup.finished.length, 1);
      const events = (yield* owner.history).events;
      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[1]?.eventId, expected?.eventId);
      assert.strictEqual(events[1]?.workflow, "test-apply");
      assert.isTrue(
        events[1]?.changes.some((item) => item.entity === "binding" && item.action === "enabled"),
      );
      assert.isTrue(events[1]?.changes.some((item) => item.entity === "projection"));
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("constructing an owner inside a composed write cannot deliver its unfinished event", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* writeLibrary(
      f.home,
      Effect.gen(function* () {
        yield* Effect.flatMap(Library.Service, (owner) => owner.import.collection(f.request)).pipe(
          Effect.provide(f.layer),
        );
        // Construction is legal inside a write, but this first checkpoint is not the whole action.
        const snapshot = yield* Effect.flatMap(Library.Service, (owner) => owner.read).pipe(
          Effect.provide(f.layer),
        );
        if (snapshot._tag !== "Present") return yield* Effect.die("Missing imported state");
        const writer = yield* LibraryWriter;
        yield* writer.save(
          { ...snapshot.state, enabled: [{ skill: snapshot.state.skills[0]!.skill_id }] },
          snapshot.state,
        );
      }),
    );
    yield* Effect.gen(function* () {
      const events = (yield* (yield* Library.Service).history).events;
      assert.strictEqual(events.length, 1);
      assert.deepStrictEqual(
        events[0]?.changes.map((item) => `${item.entity}:${item.action}`),
        ["collection:added", "skill:added", "binding:enabled"],
      );
      assert.isUndefined(
        (yield* readEnvelope(yield* f.fs.readFileString(f.statePath))).historyDelivery,
      );
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("retains failed delivery for a later healthy owner", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.makeDirectory(f.logPath, { recursive: true });
    const revision = yield* Effect.gen(function* () {
      const owner = yield* Library.Service;
      yield* owner.import.collection(f.request);
      return (yield* owner.read).revision;
    }).pipe(Effect.provide(f.layer));
    const queue = (yield* readEnvelope(yield* f.fs.readFileString(f.statePath))).historyDelivery;
    assert.strictEqual(queue?.pending.length, 1);
    yield* f.fs.remove(f.logPath, { recursive: true });
    yield* Effect.gen(function* () {
      const owner = yield* Library.Service;
      assert.strictEqual((yield* owner.read).revision, revision);
      assert.strictEqual(
        (yield* owner.history).events[0]?.eventId,
        queue?.pending[0]?.event.eventId,
      );
      assert.isUndefined(
        (yield* readEnvelope(yield* f.fs.readFileString(f.statePath))).historyDelivery,
      );
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refuses an unsupported delivery format without changing its state file", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Effect.flatMap(Library.Service, (owner) => owner.import.collection(f.request)).pipe(
      Effect.provide(f.layer),
    );
    const state = yield* readEnvelope(yield* f.fs.readFileString(f.statePath));
    const invalid = JSON.stringify({
      ...state,
      historyDelivery: { schemaVersion: 999, pending: [] },
    });
    yield* f.fs.writeFileString(f.statePath, invalid);
    assert.strictEqual(
      (yield* Effect.flip(inspectLocalLibraryState(f.home)))._tag,
      "InvalidLibraryState",
    );
    assert.strictEqual(yield* f.fs.readFileString(f.statePath), invalid);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const failure of ["storage", "defect"] as const)
  it.effect(`retains committed state and settles the writer after history ${failure}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const defect = new Error("history publication defect");
      const files: FileSystem.FileSystem = {
        ...f.fs,
        rename: (from, to) =>
          to === f.logPath
            ? failure === "storage"
              ? Effect.fail(
                  systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: to,
                  }),
                )
              : Effect.die(defect)
            : f.fs.rename(from, to),
      };
      const owner = yield* Effect.flatMap(Library.Service, Effect.succeed).pipe(
        Effect.provide(f.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, files)))),
      );
      const exit = yield* Effect.exit(owner.import.collection(f.request));
      assert.strictEqual(exit._tag, failure === "storage" ? "Success" : "Failure");
      if (Exit.isFailure(exit))
        assert.isTrue(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect === defect,
          ),
        );
      const committed = yield* inspectLocalLibraryState(f.home);
      assert.isTrue(committed.present);
      if (committed.present) assert.strictEqual(committed.state.collections.length, 1);
      const revision = snapshotOf(committed).revision;
      const queued = (yield* readEnvelope(yield* f.fs.readFileString(f.statePath))).historyDelivery;
      assert.strictEqual(queued?.pending.length, 1);
      if (failure === "defect") {
        // Startup recovery must expose the same defect, rather than hiding it as a warning.
        const startup = yield* Effect.exit(
          Effect.flatMap(Library.Service, Effect.succeed).pipe(
            Effect.provide(
              f.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, files))),
            ),
          ),
        );
        assert.isTrue(Exit.isFailure(startup) && Cause.hasDies(startup.cause));
      }
      // Acquiring a fresh writer proves both the home and replacement locks settled.
      yield* writeLibrary(f.home, Effect.void);
      yield* Effect.gen(function* () {
        const recovered = yield* Library.Service;
        assert.strictEqual((yield* recovered.read).revision, revision);
        assert.strictEqual((yield* recovered.history).events.length, 1);
        assert.strictEqual(
          (yield* recovered.history).events[0]?.eventId,
          queued?.pending[0]?.event.eventId,
        );
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("preserves caller interruption after committed state and settles history locks", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const committed = yield* Deferred.make<void>();
    const owner = yield* Effect.flatMap(Library.Service, Effect.succeed).pipe(
      Effect.provide(f.layer),
    );
    const writing = yield* writeLibrary(
      f.home,
      Effect.gen(function* () {
        yield* owner.import.collection(f.request);
        yield* Deferred.succeed(committed, undefined);
        yield* Effect.never;
      }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(committed);
    yield* Fiber.interrupt(writing);
    const exit = yield* Fiber.await(writing);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    yield* writeLibrary(f.home, Effect.void);
    const after = yield* owner.read;
    assert.strictEqual(after._tag, "Present");
    if (after._tag === "Present") assert.strictEqual(after.state.collections.length, 1);
    assert.strictEqual((yield* owner.history).events.length, 1);
    assert.isUndefined(
      (yield* readEnvelope(yield* f.fs.readFileString(f.statePath))).historyDelivery,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("does not recover an interrupted history delivery as a successful retry", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    // A known storage failure keeps a committed event queued.
    yield* f.fs.makeDirectory(f.logPath, { recursive: true });
    yield* Effect.flatMap(Library.Service, (owner) => owner.import.collection(f.request)).pipe(
      Effect.provide(f.layer),
    );
    yield* f.fs.remove(f.logPath, { recursive: true });
    const exit = yield* Effect.exit(
      recoverLibraryHistory(f.home).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          readFileString: (path, ...args) =>
            path === f.logPath ? Effect.interrupt : f.fs.readFileString(path, ...args),
        }),
      ),
    );
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    assert.strictEqual(
      (yield* readEnvelope(yield* f.fs.readFileString(f.statePath))).historyDelivery?.pending
        .length,
      1,
    );
    yield* recoverLibraryHistory(f.home);
    assert.isUndefined(
      (yield* readEnvelope(yield* f.fs.readFileString(f.statePath))).historyDelivery,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "external audit corruption preserves committed writes and replays queued identities after archival",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const owner = yield* Library.Service.pipe(Effect.provide(f.layer));
      yield* owner.import.collection(f.request);
      const delivered = (yield* owner.history).events;
      const damaged = `${yield* f.fs.readFileString(f.logPath)}{ externally damaged tail`;
      yield* f.fs.writeFileString(f.logPath, damaged);

      // Two actual owner mutations still commit; only their history delivery is blocked.
      yield* owner.remove({ query: "review", dryRun: false });
      yield* owner.import.collection(f.request);
      const before = yield* owner.read;
      assert.strictEqual(before._tag, "Present");
      const queued = (yield* readEnvelope(yield* f.fs.readFileString(f.statePath))).historyDelivery!
        .pending;
      assert.strictEqual(queued.length, 2);
      assert.strictEqual(new Set(queued.map((item) => item.event.eventId)).size, 2);
      const failure = yield* Effect.flip(owner.history);
      assert.strictEqual(failure._tag, "LibraryAuditInvalid");
      if (failure._tag === "LibraryAuditInvalid") {
        assert.strictEqual(failure.path, f.logPath);
        assert.strictEqual(failure.line, delivered.length + 1);
      }
      assert.deepStrictEqual(yield* owner.recovery.list, []);
      assert.strictEqual(yield* f.fs.readFileString(f.logPath), damaged);

      // Execute the reported recovery contract explicitly; SKIT never discards damaged bytes itself.
      const archive = `${f.logPath}.damaged`;
      yield* f.fs.rename(f.logPath, archive);
      const recovered = yield* Library.Service.pipe(Effect.provide(f.layer));
      assert.strictEqual((yield* recovered.read).revision, before.revision);
      assert.deepStrictEqual(
        (yield* recovered.history).events,
        queued.map((item) => item.event),
      );
      assert.strictEqual(yield* f.fs.readFileString(archive), damaged);
      assert.isUndefined(
        (yield* readEnvelope(yield* f.fs.readFileString(f.statePath))).historyDelivery,
      );
      const log = yield* f.fs.readFileString(f.logPath);
      yield* recoverLibraryHistory(f.home);
      assert.strictEqual(yield* f.fs.readFileString(f.logPath), log);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
