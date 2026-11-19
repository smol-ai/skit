import { Cause, Effect, Schema, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { skitLayer, skitConfigurationLayer } from "@smolai/skit-core/platform";
import { authorWorkspaceLayer, type AuthorSyncResult } from "@smolai/skit-core/author";
import { makeAuthorSyncWorld } from "../platform/author-sync-fixture/world.js";
import { authorLayer, refreshWorkspace } from "../platform/author-sync-fixture/history.js";
import { Renderer } from "../terminal/renderer.js";
import { result } from "../commands/result.js";
import { commandFailure } from "../commands/failure-classification.js";
import type { ScenarioStory } from "./journey-stories.js";
import type { StartingWorld } from "./contracts.js";
import type { TypeCommand } from "./interaction-recorder.js";

type World = Effect.Success<ReturnType<typeof makeAuthorSyncWorld>>;
type Device = World["a"];

const synced = (
  device: Device,
  typed: TypeCommand,
  status: AuthorSyncResult["status"],
  options: { first?: boolean; preview?: boolean; approve?: boolean } = {},
) =>
  Effect.gen(function* () {
    yield* typed(
      `skit author sync${options.first ? " --to swyx/tools --visibility private" : ""}${options.preview ? "" : " --apply"}${options.approve ? " --allow-large-deletion" : ""}`,
    );
    const renderer = yield* Renderer;
    const value = yield* renderer.withStatus(
      "Synchronizing skit",
      options.preview
        ? options.first
          ? device.startSync(true, false).pipe(Effect.flatMap(Fiber.join))
          : device.preview()
        : device.sync(options.first, options.approve),
    );
    yield* renderer.result(result("sync", value));
    yield* Schema.decodeUnknownEffect(
      Schema.Literal(true).annotate({
        message:
          "Scenario assertion failed: " + JSON.stringify({ expected: status, actual: value }),
      }),
    )(value.status === status);
    if (value.status === "ready" || value.status === "first_sync_ready")
      yield* Schema.decodeUnknownEffect(
        Schema.Literal(true).annotate({
          message: "Scenario assertion failed: " + JSON.stringify({ actual: value }),
        }),
      )(!value.changed);
    return value;
  });

// Failures are displayed while the journey continues to prove recovery.
const failed = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  tag: "RegistryUnreachable" | "DestinationExistsWithoutHistory" | "AuthorSyncStateInvalid",
) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.result(operation);
    yield* Schema.decodeUnknownEffect(
      Schema.Literal(true).annotate({
        message: "Scenario assertion failed: " + JSON.stringify({ expected: tag, actual: outcome }),
      }),
    )(
      outcome._tag === "Failure" &&
        typeof outcome.failure === "object" &&
        outcome.failure !== null &&
        "_tag" in outcome.failure &&
        outcome.failure._tag === tag,
    );
    if (outcome._tag === "Failure")
      yield* (yield* Renderer).failure(commandFailure(Cause.fail(outcome.failure)));
  });

const platform = Layer.mergeAll(
  skitLayer,
  skitConfigurationLayer(),
  authorWorkspaceLayer.pipe(Layer.provide(skitLayer)),
);
const worldLabels = {
  connection: "Initial connection",
  kind: "Joining workspace contents",
  direction: "Structural replacement",
  boundary: "Dropped response at",
  action: "Preview operation",
  operation: "Interrupted write operation",
  winner: "Later edit seen by",
  race: "Concurrent Registry move at",
  removedPath: "Path removed during the scenario",
  noteCount: "Reference notes before removal",
  removeCount: "Reference notes removed",
  checkpoint: "Checkpoint bytes supplied by the fixture",
};

// This owner binds declared inputs to the real fixture, the production layers and the
// conservation check. Both Vitest and Atlas call the resulting ScenarioStory directly.
const scenario = <
  const W extends StartingWorld & {
    readonly connection: "unconnected" | "connected" | "existing-destination";
  },
  E,
>(input: {
  readonly name: string;
  readonly description: string;
  readonly world: W;
  readonly terminalDevice?: string;
  readonly run: (
    world: World,
    typed: TypeCommand,
    starting: W,
  ) => Effect.Effect<
    void,
    E,
    | Renderer
    | TestClock.TestClock
    | Effect.Services<
        ReturnType<Device["sync"]> | ReturnType<World["connect"]> | ReturnType<World["copies"]>
      >
  >;
}) =>
  ({
    _tag: "Scenario",
    name: `author-sync/${input.name}`,
    description: input.description,
    world: input.world,
    worldLabels,
    terminalDevice: input.terminalDevice ?? "a",
    evidence:
      "Real workspace, history, filesystem application and CLI sync workflow against a simulated wire-level Registry. Transport faults, restarts and edit times are scripted. CLI parsing, server authorization/storage durability and live networking are not demonstrated. Setup and other-device operations are outside the displayed command transcript. Assertions fail the run; all authored inputs are checked for recoverability.",
    answers: [],
    run: (root, typed) =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = yield* makeAuthorSyncWorld(root);
          if (input.world.connection === "connected") yield* world.connect();
          if (input.world.connection === "existing-destination") yield* world.a.sync(true);
          yield* input.run(world, typed, input.world);
          const missing = yield* world.missing(yield* world.copies());
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message: "Scenario assertion failed: " + JSON.stringify({ missing }),
            }),
          )(missing.length === 0);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(TestClock.layer(), platform))),
  }) satisfies ScenarioStory<unknown, Renderer>;

const scenarios = [
  ...(["empty", "nonempty"] as const).map((kind) =>
    scenario({
      name: `no-base-${kind}`,
      description: `Join a connected destination from a ${kind} workspace without a merge base.`,
      world: { connection: "connected", kind },
      terminalDevice: "c",
      run: (world, typed, { kind }) =>
        Effect.gen(function* () {
          yield* world.a.edit("notes/remote.txt", "Existing remote guidance\n", "remote");
          yield* world.a.sync();
          if (kind === "empty")
            for (const file of yield* world.c.files()) yield* world.c.remove(file.path);
          else yield* world.c.edit("notes/third.txt", "Third device guidance\n", "remote");
          yield* synced(world.c, typed, kind === "empty" ? "pulled" : "merged");
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message:
                "Scenario assertion failed: " +
                JSON.stringify({ actual: yield* world.c.read("notes/remote.txt") }),
            }),
          )((yield* world.c.read("notes/remote.txt")) === "Existing remote guidance\n");
          if (kind === "nonempty")
            yield* Schema.decodeUnknownEffect(
              Schema.Literal(true).annotate({
                message:
                  "Scenario assertion failed: " +
                  JSON.stringify({ actual: yield* world.c.read("notes/third.txt") }),
              }),
            )((yield* world.c.read("notes/third.txt")) === "Third device guidance\n");
          yield* world.a.sync();
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message:
                "Scenario assertion failed: " +
                JSON.stringify({ a: yield* world.a.files(), c: yield* world.c.files() }),
            }),
          )(JSON.stringify(yield* world.a.files()) === JSON.stringify(yield* world.c.files()));
        }),
    }),
  ),
  ...(["file-to-directory", "directory-to-file"] as const).map((direction) =>
    scenario({
      name: direction,
      description: `Apply a ${direction} replacement through the production removal guard and tree writer.`,
      world: { connection: "unconnected", direction },
      terminalDevice: "b, then a",
      run: (world, typed, { direction }) =>
        Effect.gen(function* () {
          const before = direction === "file-to-directory" ? "notes" : "notes/child.txt";
          const after = direction === "file-to-directory" ? "notes/child.txt" : "notes";
          yield* world.a.edit(before, "Original guidance\n", "remote");
          yield* world.connect();
          yield* world.b.remove("notes");
          yield* world.b.edit(after, "Replacement guidance\n", "remote");
          yield* synced(world.b, typed, "waiting_for_removal");
          yield* synced(world.b, typed, "pushed", { approve: true });
          yield* synced(world.a, typed, "pulled");
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message:
                "Scenario assertion failed: " +
                JSON.stringify({
                  direction,
                  expectedPath: after,
                  actual: yield* world.a.read(after),
                  a: yield* world.a.files(),
                  b: yield* world.b.files(),
                }),
            }),
          )(
            (yield* world.a.read(after)) === "Replacement guidance\n" &&
              JSON.stringify(yield* world.a.files()) === JSON.stringify(yield* world.b.files()),
          );
        }),
    }),
  ),
  scenario({
    name: "remote-cas-race",
    description:
      "Another device moves Registry current after a push reads it; replan and merge without overwriting either edit.",
    world: { connection: "connected", race: "before-move" },
    run: (world, typed, { race }) =>
      Effect.gen(function* () {
        yield* world.a.edit("notes/a.txt", "A's guidance\n", "remote");
        yield* world.a.backUp();
        const gate = yield* world.server.gate("a", race);
        yield* typed("skit author sync --apply");
        const pending = yield* world.a.startSync();
        yield* gate.reached();
        yield* world.b.edit("notes/b.txt", "B's concurrent guidance\n", "remote");
        yield* world.b.sync();
        yield* gate.release();
        const value = yield* Fiber.join(pending);
        yield* (yield* Renderer).result(result("sync", value));
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message: "Scenario assertion failed: " + JSON.stringify({ actual: value }),
          }),
        )(value.status === "merged");
        yield* world.b.sync();
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message:
              "Scenario assertion failed: " +
              JSON.stringify({ a: yield* world.a.files(), b: yield* world.b.files() }),
          }),
        )(JSON.stringify(yield* world.a.files()) === JSON.stringify(yield* world.b.files()));
      }),
  }),
  scenario({
    name: "first-connection",
    description:
      "Preview and create a private destination, then repeat sync without publishing a Release.",
    world: { connection: "unconnected" },
    run: (world, typed) =>
      Effect.gen(function* () {
        const before = yield* world.a.files();
        yield* synced(world.a, typed, "first_sync_ready", { first: true, preview: true });
        const revisions = yield* world.server.revisions();
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message: "Scenario assertion failed: " + JSON.stringify({ revisions }),
          }),
        )(revisions.length === 0);
        const identity = yield* world.a.exists(".skit/workspace.json");
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message: "Scenario assertion failed: " + JSON.stringify({ identity }),
          }),
        )(!identity);
        const created = yield* synced(world.a, typed, "created", { first: true });
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message:
              "Scenario assertion failed: " +
              JSON.stringify({
                actual: created,
              }),
          }),
        )(created.status === "created" && !created.published);
        yield* synced(world.a, typed, "up_to_date");
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message:
              "Scenario assertion failed: " +
              JSON.stringify({ before, after: yield* world.a.files() }),
          }),
        )(JSON.stringify(before) === JSON.stringify(yield* world.a.files()));
      }),
  }),
  ...(["push", "pull", "merge"] as const).map((action) =>
    scenario({
      name: `preview-${action}`,
      description: `Preview a connected ${action}, verify files and current stay unchanged, then apply it.`,
      world: { connection: "connected", action },
      run: (world, typed, { action }) =>
        Effect.gen(function* () {
          if (action !== "push") {
            yield* world.b.edit("notes/remote.txt", "Remote review guidance\n", "remote");
            yield* world.b.sync();
          }
          if (action !== "pull")
            yield* world.a.edit("notes/local.txt", "Local review guidance\n", "remote");
          const before = yield* world.a.files();
          const current = yield* world.server.current();
          const preview = yield* synced(world.a, typed, "ready", { preview: true });
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message:
                "Scenario assertion failed: " +
                JSON.stringify({ expected: action, actual: preview }),
            }),
          )(preview.status === "ready" && preview.action === action);
          const after = yield* world.a.files();
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message:
                "Scenario assertion failed: " +
                JSON.stringify({
                  before,
                  after,
                }),
            }),
          )(JSON.stringify(before) === JSON.stringify(after));
          const currentAfter = yield* world.server.current();
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message:
                "Scenario assertion failed: " +
                JSON.stringify({
                  before: current,
                  after: currentAfter,
                }),
            }),
          )(current === currentAfter);
          yield* synced(
            world.a,
            typed,
            action === "push" ? "pushed" : action === "pull" ? "pulled" : "merged",
          );
          yield* world.b.sync();
          yield* world.a.sync();
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message:
                "Scenario assertion failed: " +
                JSON.stringify({ a: yield* world.a.files(), b: yield* world.b.files() }),
            }),
          )(JSON.stringify(yield* world.a.files()) === JSON.stringify(yield* world.b.files()));
        }),
    }),
  ),
  ...(["before-create", "after-create", "after-post", "after-move"] as const).map((boundary) =>
    scenario({
      name: `creation-lost-response-${boundary}`,
      description: `Lose a transport response at ${boundary}, restart and resume the saved first-connection intent.`,
      world: { connection: "unconnected", boundary },
      run: (world, typed, { boundary }) =>
        Effect.gen(function* () {
          yield* world.server.dropNextResponse("a", boundary);
          yield* typed("skit author sync --to swyx/tools --visibility private --apply");
          yield* failed(world.a.sync(true), "RegistryUnreachable");
          yield* world.a.restart();
          // after-move resumes as up_to_date; earlier boundaries resume creation or Sending.
          yield* typed("skit author sync --apply");
          const value = yield* world.a.sync();
          yield* (yield* Renderer).result(result("sync", value));
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message:
                "Scenario assertion failed: " +
                JSON.stringify({
                  history: yield* world.server.currentHistory(),
                }),
            }),
          )((yield* world.server.currentHistory()).length === 1);
          yield* synced(world.a, typed, "up_to_date");
        }),
    }),
  ),
  scenario({
    name: "destination-exists",
    description:
      "Refuse to claim a destination another workspace created, keeping both workspaces and remote history.",
    world: { connection: "existing-destination" },
    terminalDevice: "b",
    run: (world, typed) =>
      Effect.gen(function* () {
        const before = yield* world.b.files();
        const revisions = yield* world.server.revisions();
        yield* typed("skit author sync --to swyx/tools --visibility private --apply");
        yield* failed(world.b.sync(true), "DestinationExistsWithoutHistory");
        const after = yield* world.b.files();
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message:
              "Scenario assertion failed: " +
              JSON.stringify({
                before,
                after,
              }),
          }),
        )(JSON.stringify(before) === JSON.stringify(after));
        const revisionsAfter = yield* world.server.revisions();
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message:
              "Scenario assertion failed: " +
              JSON.stringify({ before: revisions, after: revisionsAfter }),
          }),
        )(JSON.stringify(revisions) === JSON.stringify(revisionsAfter));
      }),
  }),
  ...(["before-move", "after-move"] as const).map((boundary) =>
    scenario({
      name: `sending-recovery-${boundary}`,
      description: `Interrupt a connected push ${boundary}, keep a newer local edit and recover after restart.`,
      world: { connection: "connected", boundary },
      run: (world, typed, { boundary }) =>
        Effect.gen(function* () {
          yield* world.a.edit("notes/review.txt", "First local save\n", "remote");
          yield* world.a.backUp();
          yield* world.server.dropNextResponse("a", boundary);
          yield* typed("skit author sync --apply");
          yield* failed(world.a.sync(), "RegistryUnreachable");
          yield* world.a.restart();
          yield* world.a.edit("notes/new.txt", "New save after interruption\n", "remote");
          yield* typed("skit author sync --apply");
          const value = yield* world.a.sync();
          yield* (yield* Renderer).result(result("sync", value));
          yield* world.b.sync();
          const earlier = yield* world.b.read("notes/review.txt");
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message: "Scenario assertion failed: " + JSON.stringify({ actual: earlier }),
            }),
          )(earlier === "First local save\n");
          const newer = yield* world.b.read("notes/new.txt");
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message:
                "Scenario assertion failed: " +
                JSON.stringify({
                  actual: newer,
                }),
            }),
          )(newer === "New save after interruption\n");
        }),
    }),
  ),
  ...(["pull", "merge"] as const).map((operation) =>
    scenario({
      name: `writing-recovery-${operation}`,
      description: `Restart after the first file of a ${operation} is written, preview without resuming writes, then finish safely.`,
      world: { connection: "connected", operation },
      run: (world, typed, { operation }) =>
        Effect.gen(function* () {
          yield* world.b.edit("notes/1.txt", "First remote file\n");
          yield* world.b.edit("notes/2.txt", "Second remote file\n");
          yield* world.b.sync();
          if (operation === "merge")
            yield* world.a.edit("notes/local.txt", "Independent local save\n", "remote");
          yield* typed("skit author sync --apply");
          const { pending, written } = yield* world.a.startSyncPausingAfterWrite("notes/1.txt");
          yield* written;
          yield* world.a.restart();
          yield* Fiber.await(pending);
          const checkpoint = yield* world.a.readCheckpoint();
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message: "Scenario assertion failed: " + JSON.stringify({ checkpoint }),
            }),
          )(checkpoint.includes('"Writing"'));
          yield* synced(world.a, typed, "ready", { preview: true });
          const checkpointAfter = yield* world.a.readCheckpoint();
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message:
                "Scenario assertion failed: " +
                JSON.stringify({
                  before: checkpoint,
                  after: checkpointAfter,
                }),
            }),
          )(checkpoint === checkpointAfter);
          const secondFile = yield* world.a.exists("notes/2.txt");
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message: "Scenario assertion failed: " + JSON.stringify({ secondFile }),
            }),
          )(!secondFile);
          yield* world.a.edit("notes/new.txt", "Save while interrupted\n", "remote");
          yield* typed("skit author sync --apply");
          const value = yield* world.a.sync();
          yield* (yield* Renderer).result(result("sync", value));
          yield* world.b.sync();
          yield* world.a.sync();
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message:
                "Scenario assertion failed: " +
                JSON.stringify({ a: yield* world.a.files(), b: yield* world.b.files() }),
            }),
          )(JSON.stringify(yield* world.a.files()) === JSON.stringify(yield* world.b.files()));
        }),
    }),
  ),
  ...(["local", "remote", "equal"] as const).map((winner) =>
    scenario({
      name: `overlap-${winner}`,
      description:
        winner === "equal"
          ? "Observe simultaneous overlapping edits: equal times edits were first seen choose local and keep both inputs."
          : `Observe the ${winner} edit later, then merge and keep the losing revision.`,
      world: { connection: "connected", winner },
      terminalDevice: "b",
      run: (world, typed, { winner }) =>
        Effect.gen(function* () {
          const first = winner === "remote" ? world.b : world.a;
          const second = winner === "remote" ? world.a : world.b;
          yield* first.edit("notes/shared.txt", `${first.name}'s review instruction\n`, "remote");
          yield* refreshWorkspace(first.workspace).pipe(Effect.provide(authorLayer(first.home)));
          if (winner !== "equal") yield* TestClock.adjust("1 minute");
          yield* second.edit("notes/shared.txt", `${second.name}'s review instruction\n`, "remote");
          yield* refreshWorkspace(second.workspace).pipe(Effect.provide(authorLayer(second.home)));
          yield* world.a.sync();
          const merged = yield* synced(world.b, typed, "merged");
          const kept = winner === "remote" ? "remote" : "local";
          const expectedContent = `${winner === "remote" ? world.a.name : world.b.name}'s review instruction\n`;
          const actualContent = yield* world.b.read("notes/shared.txt");
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message:
                "Scenario assertion failed: " +
                JSON.stringify({ expected: kept, actual: merged, expectedContent, actualContent }),
            }),
          )(
            merged.status === "merged" &&
              merged.choices.some(
                (choice) => choice.kind === "both_modified" && choice.kept === kept,
              ) &&
              actualContent === expectedContent,
          );
          yield* world.a.sync();
          const a = yield* world.a.files();
          const b = yield* world.b.files();
          yield* Schema.decodeUnknownEffect(
            Schema.Literal(true).annotate({
              message: "Scenario assertion failed: " + JSON.stringify({ a, b }),
            }),
          )(JSON.stringify(a) === JSON.stringify(b));
        }),
    }),
  ),
  scenario({
    name: "delete-versus-edit",
    description:
      "Approve a local removal while a remote edit exists: the edit wins and both input revisions remain recoverable.",
    world: { connection: "connected", removedPath: "notes/shared.txt" },
    terminalDevice: "b",
    run: (world, typed, { removedPath }) =>
      Effect.gen(function* () {
        yield* world.a.edit(removedPath, "Original note\n");
        yield* world.a.sync();
        yield* world.b.sync();
        yield* world.b.remove(removedPath);
        yield* world.a.edit(removedPath, "Edited review note\n", "remote");
        yield* world.a.sync();
        const merged = yield* synced(world.b, typed, "merged", { approve: true });
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message: "Scenario assertion failed: " + JSON.stringify({ actual: merged }),
          }),
        )(
          merged.status === "merged" &&
            merged.choices.some(
              (choice) => choice.kind === "delete_modify" && choice.kept === "remote",
            ),
        );
        const content = yield* world.b.read(removedPath);
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message: "Scenario assertion failed: " + JSON.stringify({ actual: content }),
          }),
        )(content === "Edited review note\n");
      }),
  }),
  scenario({
    name: "removal-waits-and-reappears",
    description:
      "Hold a small removal, then let the file reappear before approval; remote content remains intact.",
    world: { connection: "connected", removedPath: "notes/keep.txt" },
    run: (world, typed, { removedPath }) =>
      Effect.gen(function* () {
        yield* world.a.edit(removedPath, "Keep this guidance\n");
        yield* world.a.sync();
        yield* world.b.sync();
        yield* world.a.remove(removedPath);
        const current = yield* world.server.current();
        yield* synced(world.a, typed, "waiting_for_removal");
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message:
              "Scenario assertion failed: " +
              JSON.stringify({
                before: current,
                after: yield* world.server.current(),
              }),
          }),
        )(current === (yield* world.server.current()));
        yield* world.a.edit(removedPath, "Keep this guidance\n");
        yield* synced(world.a, typed, "up_to_date");
      }),
  }),
  scenario({
    name: "bulk-removal-approval",
    description:
      "Delete eight of fourteen known files, keep the remote copy while blocked, then explicitly approve that removal.",
    world: { connection: "connected", noteCount: 12, removeCount: 8 },
    run: (world, typed, { noteCount, removeCount }) =>
      Effect.gen(function* () {
        for (let i = 0; i < noteCount; i++)
          yield* world.a.edit(`notes/${i}.txt`, `Review reference ${i}\n`);
        yield* world.a.sync();
        yield* world.b.sync();
        const before = yield* world.b.files();
        for (let i = 0; i < removeCount; i++) yield* world.a.remove(`notes/${i}.txt`);
        const blocked = yield* synced(world.a, typed, "blocked");
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message:
              "Scenario assertion failed: " +
              JSON.stringify({ expectedCount: removeCount, total: before.length, actual: blocked }),
          }),
        )(
          blocked.status === "blocked" &&
            blocked.deleting === removeCount &&
            blocked.of === before.length,
        );
        yield* world.b.sync();
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message:
              "Scenario assertion failed: " +
              JSON.stringify({ before, after: yield* world.b.files() }),
          }),
        )(JSON.stringify(before) === JSON.stringify(yield* world.b.files()));
        yield* synced(world.a, typed, "pushed", { approve: true });
        yield* world.b.sync();
        const expected = before.filter(
          (file) =>
            !Array.from({ length: removeCount }, (_, i) => `notes/${i}.txt`).includes(file.path),
        );
        const actual = yield* world.b.files();
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message:
              "Scenario assertion failed: " +
              JSON.stringify({
                expected,
                actual,
              }),
          }),
        )(JSON.stringify(expected) === JSON.stringify(actual));
      }),
  }),
  scenario({
    name: "invalid-checkpoint",
    description:
      "Refuse an unreadable sync checkpoint without changing files or remote history, then resume after its original bytes are restored.",
    world: { connection: "connected", checkpoint: "{unfinished" },
    run: (world, typed, { checkpoint: invalid }) =>
      Effect.gen(function* () {
        const saved = yield* world.a.readCheckpoint();
        const before = yield* world.a.files();
        const remote = yield* world.server.revisions();
        yield* world.a.writeCheckpoint(invalid);
        yield* typed("skit author sync --apply");
        yield* failed(world.a.sync(), "AuthorSyncStateInvalid");
        const checkpointAfter = yield* world.a.readCheckpoint();
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message:
              "Scenario assertion failed: " +
              JSON.stringify({
                expected: invalid,
                actual: checkpointAfter,
              }),
          }),
        )(checkpointAfter === invalid);
        const filesAfter = yield* world.a.files();
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message:
              "Scenario assertion failed: " +
              JSON.stringify({
                before,
                after: filesAfter,
              }),
          }),
        )(JSON.stringify(before) === JSON.stringify(filesAfter));
        const revisionsAfter = yield* world.server.revisions();
        yield* Schema.decodeUnknownEffect(
          Schema.Literal(true).annotate({
            message:
              "Scenario assertion failed: " +
              JSON.stringify({ before: remote, after: revisionsAfter }),
          }),
        )(JSON.stringify(remote) === JSON.stringify(revisionsAfter));
        yield* world.a.writeCheckpoint(saved);
        yield* synced(world.a, typed, "up_to_date");
      }),
  }),
];

export const authorSyncScenarioSet = {
  command: "author sync",
  scenarios,
};
