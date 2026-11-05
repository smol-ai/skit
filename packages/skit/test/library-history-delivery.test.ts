import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";
import { join } from "node:path";
import { Library } from "../src/library/library.js";
import { LibraryActor } from "../src/library/actor.js";
import { LibraryState } from "../src/library/library-state.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { StateEnvelope } from "../src/library/store/history-delivery.js";
import {
  inspectLocalLibraryState,
  writeLibrary,
  LibraryWriter,
} from "../src/library/store/library-store.js";
import { snapshotOf } from "../src/library/snapshot.js";
import { skitLayer } from "../src/platform/layer.js";

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
    routing: { _tag: "Configured", home: root, configHome: root, overrides: { codex: [skills] } },
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
      assert.strictEqual(outcome._tag, boundary === "state" ? "Failure" : "Success");
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
        Effect.provideService(LibraryActor, "test-apply"),
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
