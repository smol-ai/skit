import { withLibraryOwner } from "./helpers/library-owner.js";
import { join } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { systemError, type PlatformError } from "effect/PlatformError";
import { MachineSettings, skitLayer, type LibraryState } from "@smolai/skit-core";
import { setupApplyCommand } from "../src/library/setup/apply-command.js";
import { runSetup } from "@smolai/skit-core/library/setup";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";
import { libraryHome, scratch } from "./helpers/library-home.js";
import { homeLockIsFree } from "./helpers/home-lock.js";

const fixture = Effect.fn("Test.setupOperationFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* scratch("skit-setup-operation-"));
  const source = join(root, "agents", "review");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.writeFileString(
    join(source, "SKILL.md"),
    "---\nname: review\ndescription: review\n---\n\nOriginal bytes\n",
  );
  const home = yield* libraryHome({
    home: join(root, "library"),
    inventoryHome: root,
    roots: { codex: [join(root, "agents")], "claude-code": [join(root, "claude")] },
  });
  const options = {
    libraryHome: home.home,
    inventory: home.inventory,
    probePath: "",
    skillsStateHome: join(root, "state"),
  };
  const scan = yield* home.owned(runSetup({ ...options, persistRoots: false }));
  const interaction = yield* makeScriptedInteraction([]);
  const apply = setupApplyCommand({
    options,
    manageOptions: { installOptions: home.installOptions },
    planId: scan.onboarding.planId,
  }).pipe(withLibraryOwner, Effect.provide(interaction.layer));
  return { fs, root, source, home, apply };
});

/** The operation records `state.json` holds, as saved. */
const operations = (state: LibraryState) =>
  state.operations.map((operation) => ({
    _tag: operation._tag,
    operationId: operation.operationId,
    steps: operation.steps.map((recorded) => ({
      tag: recorded.step._tag,
      status: recorded.status,
      sources:
        recorded.step._tag === "Manage"
          ? recorded.step.selections.map((selection) => selection.source.path)
          : [],
    })),
  }));

/**
 * The real filesystem, except each replacement of `state.json` first runs `onSave` with its count
 * from one and the bytes about to land. Provided outside the owner, so its saves go through it.
 */
const watchingSaves =
  (statePath: string, onSave: (save: number, next: string) => Effect.Effect<void, PlatformError>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let saves = 0;
      return yield* effect.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            to === statePath
              ? Effect.flatMap(fs.readFileString(from), (next) =>
                  Effect.andThen(onSave(++saves, next), fs.rename(from, to)),
                )
              : fs.rename(from, to),
        }),
      );
    });

it.effect(
  "setup records its steps in state.json before running any, and its discovery folders under the same operation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let recorded: ReturnType<typeof operations> | undefined;
      const applied = yield* f.home.owned(
        f.apply.pipe(
          watchingSaves(f.home.statePath, (save, next) =>
            Effect.gen(function* () {
              if (save !== 1) return;
              const saved: LibraryState = JSON.parse(next);
              recorded = operations(saved);
              // Nothing has run yet: the copy setup manages is still the user's.
              expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(false);
            }).pipe(Effect.orDie),
          ),
        ),
      );
      if (!applied.operationId) return yield* Effect.die(new Error("Missing setup operation"));
      expect(recorded).toEqual([
        {
          _tag: "Pending",
          operationId: applied.operationId,
          steps: [{ tag: "Manage", status: "Pending", sources: [f.source] }],
        },
      ]);
      expect(operations(yield* f.home.durable)).toEqual([
        {
          _tag: "Done",
          operationId: applied.operationId,
          steps: [{ tag: "Manage", status: "Done", sources: [f.source] }],
        },
      ]);
      // Setup created this machine's identity, so it saved the discovery folders it observed.
      const settings = yield* MachineSettings.setupRecord(f.home.home, applied.operationId);
      expect(Option.map(settings, (record) => record.before.discoveryRoots)).toEqual(
        Option.some([]),
      );
      expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toContain("Original bytes");
      expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(true);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("a refused setup record changes no skill and saves no discovery folders", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const failure = yield* Effect.flip(
      f.home.owned(
        f.apply.pipe(
          watchingSaves(f.home.statePath, () =>
            Effect.fail(
              systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
                pathOrDescriptor: f.home.statePath,
              }),
            ),
          ),
        ),
      ),
    );
    expect(failure._tag).toBe("PlatformError");
    expect(yield* f.fs.exists(join(f.home.home, "state.json"))).toBe(false);
    expect((yield* MachineSettings.read(f.home.home)).setups).toEqual([]);
    expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(false);
    expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toContain("Original bytes");
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("a setup interrupted after its record is saved is finished by the next Library", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const exit = yield* Effect.exit(
      f.home.owned(
        f.apply.pipe(
          watchingSaves(f.home.statePath, (save) => (save === 2 ? Effect.interrupt : Effect.void)),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(yield* homeLockIsFree(f.home.home)).toBe(true);
    // As saved: reading it through a Library would already have recovered it.
    const saved: { operations: readonly { _tag: string; operationId: string }[] } = JSON.parse(
      yield* f.fs.readFileString(f.home.statePath),
    );
    const [pending] = saved.operations;
    expect(pending?._tag).toBe("Pending");
    // The next command's Library finishes it at startup, routed as the setup recorded.
    expect(operations(yield* f.home.durable)).toEqual([
      {
        _tag: "Done",
        operationId: pending?.operationId,
        steps: [{ tag: "Manage", status: "Done", sources: [f.source] }],
      },
    ]);
    expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(true);
  }).pipe(Effect.provide(skitLayer)),
);
