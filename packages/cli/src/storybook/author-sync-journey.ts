import { Cause, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { skitLayer, skitConfigurationLayer } from "@smolai/skit-core/platform";
import { authorWorkspaceLayer, type AuthorSyncResult } from "@smolai/skit-core/author";
import { makeAuthorSyncWorld } from "../platform/author-sync-fixture/world.js";
import { authorLayer, refreshWorkspace } from "../platform/author-sync-fixture/history.js";
import { Renderer } from "../terminal/renderer.js";
import { result } from "../commands/result.js";
import { commandFailure } from "../commands/failure-classification.js";
import type { JourneyStory } from "./journey-stories.js";
import type { TypeCommand } from "./interaction-recorder.js";

type World = Effect.Success<ReturnType<typeof makeAuthorSyncWorld>>;
type Device = World["a"];
interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly initial: string;
  readonly run: (
    world: World,
    typed: TypeCommand,
  ) => Effect.Effect<
    string,
    unknown,
    | Renderer
    | TestClock.TestClock
    | Effect.Services<
        ReturnType<Device["sync"]> | ReturnType<World["connect"]> | ReturnType<World["copies"]>
      >
  >;
}

const check = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.die(message);
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
    yield* check(value.status === status, `Expected ${status}, got ${value.status}`);
    if (value.status === "ready" || value.status === "first_sync_ready")
      yield* check(!value.changed, "A preview reported changed:true");
    return value;
  });

// Failures are displayed while the journey continues to prove recovery.
const failed = <A, E, R>(operation: Effect.Effect<A, E, R>, tag: string) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.result(operation);
    if (outcome._tag !== "Failure") return yield* Effect.die(`Expected ${tag}`);
    const failure = outcome.failure;
    yield* check(
      typeof failure === "object" && failure !== null && "_tag" in failure && failure._tag === tag,
      `Expected ${tag}, got ${String(failure)}`,
    );
    yield* (yield* Renderer).failure(commandFailure(Cause.fail(failure)));
  });

const scenarios: readonly Scenario[] = [
  ...(["empty", "nonempty"] as const).map((kind): Scenario => ({
    name: `no-base-${kind}`,
    description: `Join a connected destination from a ${kind} workspace without a merge base.`,
    initial: `Registry has current review guidance | third device has a portable remote home and ${kind} authored tree`,
    run: (world, typed) =>
      Effect.gen(function* () {
        yield* world.connect();
        yield* world.a.edit("notes/remote.txt", "Existing remote guidance\n", "remote");
        yield* world.a.sync();
        if (kind === "empty")
          for (const file of yield* world.c.files()) yield* world.c.remove(file.path);
        else yield* world.c.edit("notes/third.txt", "Third device guidance\n", "remote");
        yield* synced(world.c, typed, kind === "empty" ? "pulled" : "merged");
        yield* check(
          (yield* world.c.read("notes/remote.txt")) === "Existing remote guidance\n",
          "No-base join lost remote content",
        );
        if (kind === "nonempty")
          yield* check(
            (yield* world.c.read("notes/third.txt")) === "Third device guidance\n",
            "No-base join treated existing files as deletions",
          );
        yield* world.a.sync();
        yield* check(
          JSON.stringify(yield* world.a.files()) === JSON.stringify(yield* world.c.files()),
          "No-base devices did not converge",
        );
        return "No-base join converged | remote content kept | existing local files never treated as deletions";
      }),
  })),
  ...(["file-to-directory", "directory-to-file"] as const).map((direction): Scenario => ({
    name: direction,
    description: `Apply a ${direction} replacement through the production removal guard and tree writer.`,
    initial: `Connected devices | notes is a ${direction === "file-to-directory" ? "file" : "directory"}`,
    run: (world, typed) =>
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
        yield* check(
          (yield* world.a.read(after)) === "Replacement guidance\n" &&
            JSON.stringify(yield* world.a.files()) === JSON.stringify(yield* world.b.files()),
          "Structural replacement failed to converge",
        );
        return "Structural replacement applied | original and replacement bytes kept remotely | devices converged";
      }),
  })),
  {
    name: "remote-cas-race",
    description:
      "Another device moves Registry current after a push reads it; replan and merge without overwriting either edit.",
    initial:
      "Connected devices | two independent local saves | remote current moves before first device's compare-and-swap",
    run: (world, typed) =>
      Effect.gen(function* () {
        yield* world.connect();
        yield* world.a.edit("notes/a.txt", "A's guidance\n", "remote");
        yield* world.a.backUp();
        const gate = yield* world.server.gate("a", "before-move");
        yield* typed("skit author sync --apply");
        const pending = yield* world.a.startSync();
        yield* gate.reached();
        yield* world.b.edit("notes/b.txt", "B's concurrent guidance\n", "remote");
        yield* world.b.sync();
        yield* gate.release();
        const value = yield* Fiber.join(pending);
        yield* (yield* Renderer).result(result("sync", value));
        yield* check(value.status === "merged", "Contested current was not replanned");
        yield* world.b.sync();
        yield* check(
          JSON.stringify(yield* world.a.files()) === JSON.stringify(yield* world.b.files()),
          "CAS recovery did not converge",
        );
        return "Internal Sync.Moved replanned | both independent inputs kept | devices converged";
      }),
  },
  {
    name: "first-connection",
    description:
      "Preview and create a private destination, then repeat sync without publishing a Release.",
    initial: "One review Skill | no workspace identity, remote home or Registry SKIT",
    run: (world, typed) =>
      Effect.gen(function* () {
        const before = yield* world.a.files();
        yield* synced(world.a, typed, "first_sync_ready", { first: true, preview: true });
        yield* check(
          (yield* world.server.revisions()).length === 0 &&
            !(yield* world.a.exists(".skit/workspace.json")),
          "First preview changed remote or minted identity",
        );
        const created = yield* synced(world.a, typed, "created", { first: true });
        yield* check(
          created.status === "created" && !created.published,
          "Sync published a Release",
        );
        yield* synced(world.a, typed, "up_to_date");
        yield* check(
          JSON.stringify(before) === JSON.stringify(yield* world.a.files()),
          "Creation changed authored files",
        );
        return "Connected | one current revision | authored files unchanged | no Release published";
      }),
  },
  ...(["push", "pull", "merge"] as const).map((action): Scenario => ({
    name: `preview-${action}`,
    description: `Preview a connected ${action}, verify files and current stay unchanged, then apply it.`,
    initial: `Two connected devices | ${action === "push" ? "local edit" : action === "pull" ? "remote edit" : "independent local and remote edits"}`,
    run: (world, typed) =>
      Effect.gen(function* () {
        yield* world.connect();
        if (action !== "push") {
          yield* world.b.edit("notes/remote.txt", "Remote review guidance\n", "remote");
          yield* world.b.sync();
        }
        if (action !== "pull")
          yield* world.a.edit("notes/local.txt", "Local review guidance\n", "remote");
        const before = yield* world.a.files();
        const current = yield* world.server.current();
        const preview = yield* synced(world.a, typed, "ready", { preview: true });
        yield* check(
          preview.status === "ready" && preview.action === action,
          "Preview chose the wrong operation",
        );
        yield* check(
          JSON.stringify(before) === JSON.stringify(yield* world.a.files()) &&
            current === (yield* world.server.current()),
          "Preview changed files or Registry current",
        );
        yield* synced(
          world.a,
          typed,
          action === "push" ? "pushed" : action === "pull" ? "pulled" : "merged",
        );
        yield* world.b.sync();
        yield* world.a.sync();
        yield* check(
          JSON.stringify(yield* world.a.files()) === JSON.stringify(yield* world.b.files()),
          "Devices did not converge",
        );
        return "Preview left files and Registry current unchanged | apply converged both devices | authored inputs kept";
      }),
  })),
  ...(["before-create", "after-create", "after-post", "after-move"] as const).map(
    (boundary): Scenario => ({
      name: `creation-lost-response-${boundary}`,
      description: `Lose a transport response at ${boundary}, restart and resume the saved first-connection intent.`,
      initial: `Unconnected author | one injected disconnection at ${boundary}`,
      run: (world, typed) =>
        Effect.gen(function* () {
          yield* world.server.dropNextResponse("a", boundary);
          yield* typed("skit author sync --to swyx/tools --visibility private --apply");
          yield* failed(world.a.sync(true), "RegistryUnreachable");
          yield* world.a.restart();
          // after-move resumes as up_to_date; earlier boundaries resume creation or Sending.
          yield* typed("skit author sync --apply");
          const value = yield* world.a.sync();
          yield* (yield* Renderer).result(result("sync", value));
          yield* check(
            (yield* world.server.currentHistory()).length === 1,
            "Creation replay duplicated history",
          );
          yield* synced(world.a, typed, "up_to_date");
          return "Restart resumed saved destination | exactly one current revision | repeat is up to date";
        }),
    }),
  ),
  {
    name: "destination-exists",
    description:
      "Refuse to claim a destination another workspace created, keeping both workspaces and remote history.",
    initial: "Another device already created swyx/tools | this workspace has no history with it",
    run: (world, typed) =>
      Effect.gen(function* () {
        yield* world.a.sync(true);
        const before = yield* world.b.files();
        const revisions = yield* world.server.revisions();
        yield* typed("skit author sync --to swyx/tools --visibility private --apply");
        yield* failed(world.b.sync(true), "DestinationExistsWithoutHistory");
        yield* check(
          JSON.stringify(before) === JSON.stringify(yield* world.b.files()) &&
            JSON.stringify(revisions) === JSON.stringify(yield* world.server.revisions()),
          "Destination refusal changed content",
        );
        return "Existing destination protected | local files and Registry history unchanged";
      }),
  },
  ...(["before-move", "after-move"] as const).map((boundary): Scenario => ({
    name: `sending-recovery-${boundary}`,
    description: `Interrupt a connected push ${boundary}, keep a newer local edit and recover after restart.`,
    initial: `Connected devices | push response lost ${boundary} | newer local edit before retry`,
    run: (world, typed) =>
      Effect.gen(function* () {
        yield* world.connect();
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
        yield* check(
          (yield* world.b.read("notes/review.txt")) === "First local save\n" &&
            (yield* world.b.read("notes/new.txt")) === "New save after interruption\n",
          "Sending recovery lost an edit",
        );
        return "Sending resumed | earlier and newer saves reached the other device | inputs kept";
      }),
  })),
  ...(["pull", "merge"] as const).map((operation): Scenario => ({
    name: `writing-recovery-${operation}`,
    description: `Restart after the first file of a ${operation} is written, preview without resuming writes, then finish safely.`,
    initial: `Connected devices | two remote files | filesystem interrupted after first ${operation} write`,
    run: (world, typed) =>
      Effect.gen(function* () {
        yield* world.connect();
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
        yield* check(checkpoint.includes('"Writing"'), "No Writing checkpoint saved");
        yield* synced(world.a, typed, "ready", { preview: true });
        yield* check(
          checkpoint === (yield* world.a.readCheckpoint()) &&
            !(yield* world.a.exists("notes/2.txt")),
          "Preview resumed a pending write",
        );
        yield* world.a.edit("notes/new.txt", "Save while interrupted\n", "remote");
        yield* typed("skit author sync --apply");
        const value = yield* world.a.sync();
        yield* (yield* Renderer).result(result("sync", value));
        yield* world.b.sync();
        yield* world.a.sync();
        yield* check(
          JSON.stringify(yield* world.a.files()) === JSON.stringify(yield* world.b.files()),
          "Writing recovery did not converge",
        );
        return "Writing checkpoint resumed | all remote files and new local save kept | devices converged";
      }),
  })),
  ...(["local", "remote", "equal"] as const).map((winner): Scenario => ({
    name: `overlap-${winner}`,
    description:
      winner === "equal"
        ? "Observe simultaneous overlapping edits: equal times edits were first seen choose local and keep both inputs."
        : `Observe the ${winner} edit later, then merge and keep the losing revision.`,
    initial:
      "Connected devices | concurrent edits to the same review instruction | controlled times edits were first seen",
    run: (world, typed) =>
      Effect.gen(function* () {
        yield* world.connect();
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
        yield* check(
          merged.status === "merged" &&
            merged.choices.some(
              (choice) => choice.kind === "both_modified" && choice.kept === kept,
            ),
          "Overlap policy chose the wrong side",
        );
        yield* world.a.sync();
        return `Overlap kept ${kept} by time the edit was first seen | both inputs kept remotely | devices converged`;
      }),
  })),
  {
    name: "delete-versus-edit",
    description:
      "Approve a local removal while a remote edit exists: the edit wins and both input revisions remain recoverable.",
    initial: "Shared review note | one device deletes it while the other edits it",
    run: (world, typed) =>
      Effect.gen(function* () {
        yield* world.connect();
        yield* world.a.edit("notes/shared.txt", "Original note\n");
        yield* world.a.sync();
        yield* world.b.sync();
        yield* world.b.remove("notes/shared.txt");
        yield* world.a.edit("notes/shared.txt", "Edited review note\n", "remote");
        yield* world.a.sync();
        const merged = yield* synced(world.b, typed, "merged", { approve: true });
        yield* check(
          merged.status === "merged" &&
            merged.choices.some(
              (choice) => choice.kind === "delete_modify" && choice.kept === "remote",
            ) &&
            (yield* world.b.read("notes/shared.txt")) === "Edited review note\n",
          "Deletion replaced a concurrent edit",
        );
        return "Edit beats deletion | deleting input remains in history | edited note restored locally";
      }),
  },
  {
    name: "removal-waits-and-reappears",
    description:
      "Hold a small removal, then let the file reappear before approval; remote content remains intact.",
    initial: "Connected workspace | one missing review note below the bulk threshold",
    run: (world, typed) =>
      Effect.gen(function* () {
        yield* world.connect();
        yield* world.a.edit("notes/keep.txt", "Keep this guidance\n");
        yield* world.a.sync();
        yield* world.b.sync();
        yield* world.a.remove("notes/keep.txt");
        const current = yield* world.server.current();
        yield* synced(world.a, typed, "waiting_for_removal");
        yield* check(current === (yield* world.server.current()), "Held removal advanced current");
        yield* world.a.edit("notes/keep.txt", "Keep this guidance\n");
        yield* synced(world.a, typed, "up_to_date");
        return "Removal held | reappearing file cancelled removal | Registry content unchanged";
      }),
  },
  {
    name: "bulk-removal-approval",
    description:
      "Delete eight of fourteen known files, keep the remote copy while blocked, then explicitly approve that removal.",
    initial:
      "Connected devices | descriptor, review Skill and 12 reference notes | eight notes missing",
    run: (world, typed) =>
      Effect.gen(function* () {
        yield* world.connect();
        for (let i = 0; i < 12; i++)
          yield* world.a.edit(`notes/${i}.txt`, `Review reference ${i}\n`);
        yield* world.a.sync();
        yield* world.b.sync();
        const before = yield* world.b.files();
        for (let i = 0; i < 8; i++) yield* world.a.remove(`notes/${i}.txt`);
        const blocked = yield* synced(world.a, typed, "blocked");
        yield* check(
          blocked.status === "blocked" && blocked.deleting === 8 && blocked.of === before.length,
          "Bulk removal threshold changed",
        );
        yield* world.b.sync();
        yield* check(
          JSON.stringify(before) === JSON.stringify(yield* world.b.files()),
          "Blocked removal propagated",
        );
        yield* synced(world.a, typed, "pushed", { approve: true });
        yield* world.b.sync();
        yield* check(
          (yield* world.b.files()).length === before.length - 8,
          "Approval removed unexpected files",
        );
        return "Eight exact removals applied after explicit approval | six remaining files unchanged | earlier content kept in history";
      }),
  },
  {
    name: "invalid-checkpoint",
    description:
      "Refuse an unreadable sync checkpoint without changing files or remote history, then resume after its original bytes are restored.",
    initial: "Connected workspace | author-sync.json contains incomplete JSON",
    run: (world, typed) =>
      Effect.gen(function* () {
        yield* world.connect();
        const saved = yield* world.a.readCheckpoint();
        const before = yield* world.a.files();
        const remote = yield* world.server.revisions();
        yield* world.a.writeCheckpoint("{unfinished");
        yield* typed("skit author sync --apply");
        yield* failed(world.a.sync(), "AuthorSyncStateInvalid");
        yield* check(
          (yield* world.a.readCheckpoint()) === "{unfinished" &&
            JSON.stringify(before) === JSON.stringify(yield* world.a.files()) &&
            JSON.stringify(remote) === JSON.stringify(yield* world.server.revisions()),
          "Refusal changed checkpoint, files or history",
        );
        yield* world.a.writeCheckpoint(saved);
        yield* synced(world.a, typed, "up_to_date");
        return "Unreadable checkpoint refused intact | authored files and remote history unchanged | original checkpoint restored by fixture";
      }),
  },
];

const platform = Layer.mergeAll(
  skitLayer,
  skitConfigurationLayer(),
  authorWorkspaceLayer.pipe(Layer.provide(skitLayer)),
);
const runScenario = (scenario: Scenario, root: string, typed: TypeCommand) =>
  Effect.scoped(
    Effect.gen(function* () {
      const world = yield* makeAuthorSyncWorld(root);
      const state = yield* scenario.run(world, typed);
      yield* check(
        (yield* world.missing(yield* world.copies())).length === 0,
        "An authored input is no longer recoverable",
      );
      return state;
    }),
  ).pipe(Effect.provide(TestClock.layer()), Effect.provide(platform));

export const authorSyncJourneys: readonly JourneyStory<
  string,
  Effect.Error<ReturnType<typeof runScenario>>,
  Effect.Services<ReturnType<typeof runScenario>>
>[] = scenarios.map((scenario) => ({
  _tag: "Journey",
  name: `author-sync/${scenario.name}`,
  description: scenario.description,
  initialState: scenario.initial,
  evidence:
    "Real workspace, history, filesystem application and CLI sync workflow against a shared simulated wire-level Registry. The fixture checks revision identities, parents and compare-and-swap current moves. Transport faults, restarts, editor saves and times edits were first seen are scripted; CLI parsing, server authorization/storage durability and live networking are not demonstrated. Every authored edit must remain readable in a workspace, local history or the simulated Registry. Setup and other-device operations are outside the displayed command transcript.",
  answers: [],
  run: (root, typed) => runScenario(scenario, root, typed),
  finalState: (state) => state,
}));

export const authorSyncScenarioInventory = scenarios.map((scenario) => ({
  name: scenario.name,
  description: scenario.description,
  flow: `author-sync/${scenario.name}`,
}));
