import { basename, join, relative } from "node:path";
import { Effect, Exit, FileSystem, Option, Schema } from "effect";
import { PlatformError, systemError } from "effect/PlatformError";
import { assert, it } from "@effect/vitest";
import { InvalidLibraryState, LibraryStore, skitLayer } from "@smolai/skit-core";
import { outputContracts } from "../src/commands/output-contracts.js";
import { setupCommand } from "../src/handlers/library/setup.js";
import {
  makeScriptedInteraction,
  type ScriptedAnswer,
} from "../src/presentation/interaction-recorder.js";
import { Prompter } from "../src/presentation/prompter.js";
import { setupPrompts } from "../src/presentation/setup-steps.js";
import { SetupPlanStale } from "../src/workflows/library/setup.js";
import { captureDisk, diskChanges, noDiskChanges, type DiskDiff } from "./helpers/disk-snapshot.js";
import {
  deterministicTreeHashEffect,
  initializeLibraryMachine,
  libraryHome,
  retainObservedIn,
  scratch,
  testMachineId,
  writingTo,
} from "./helpers/library-home.js";

// Acceptance oracle for guided `skit setup` apply: docs/setup-apply-outcomes.md. Rows marked BUG
// characterize current behaviour that the setup-apply refactor (one apply workflow, one apply-time
// scan, additive stages before removals) must flip; they are not safety guarantees.

const skillBytes = (name: string, body = `${name} body`) =>
  `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${body}\n`;

/** Explicit points in the apply where a test changes the world; never a timer. */
interface Gates {
  /** Runs once the confirmation prompt has approved the plan. */
  readonly approved?: Effect.Effect<void, unknown>;
  /** Runs once the first Library state has been published. */
  readonly published?: Effect.Effect<void, unknown>;
  /** Refuses the nth Library state publication. */
  readonly failPublish?: number;
  /** Runs before every rename; a failure refuses that rename. */
  readonly rename?: (from: string, to: string) => Effect.Effect<void, PlatformError>;
}

const fixture = Effect.fn("Test.setupApplyFixture")(function* (input: { machine: boolean }) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* scratch("skit-setup-apply-");
  const agentRoot = join(root, ".codex", "skills");
  for (const name of ["alpha", "beta", "gamma"]) {
    yield* fs.makeDirectory(join(agentRoot, name), { recursive: true });
    yield* fs.writeFileString(join(agentRoot, name, "SKILL.md"), skillBytes(name));
  }
  const home = yield* libraryHome({
    home: join(root, "library"),
    inventoryHome: root,
    roots: { codex: [agentRoot] },
  });
  if (input.machine) yield* initializeLibraryMachine(home.home);
  const options = {
    libraryHome: home.home,
    inventory: home.inventory,
    probePath: "",
    skillsStateHome: join(root, "state"),
  };
  // Every full discovery scan reads the global skills.sh lock once; safety checks never do.
  const globalLock = join(options.skillsStateHome, "skills", ".skill-lock.json");
  const setup = (
    answers: readonly ScriptedAnswer[],
    gates: Gates = {},
    flags: { interactive?: boolean; dryRun?: boolean; workDirFlag?: string } = {},
  ) =>
    Effect.gen(function* () {
      let scans = 0;
      let publishes = 0;
      const interaction = yield* makeScriptedInteraction(answers);
      const exit = yield* Effect.exit(
        home.owned(
          setupCommand({
            options,
            interactive: flags.interactive ?? true,
            dryRun: flags.dryRun ?? false,
            ...(flags.workDirFlag ? { workDirFlag: flags.workDirFlag } : {}),
            localCustody: { acquisition: home.addOptions, bindings: home.bindings },
          }).pipe(
            Effect.provideServiceEffect(
              Prompter,
              Effect.map(Prompter, (prompter) => ({
                ...prompter,
                confirm: (message: string) =>
                  Effect.tap(prompter.confirm(message), (approved) =>
                    approved && message === setupPrompts.confirm
                      ? Effect.orDie(gates.approved ?? Effect.void)
                      : Effect.void,
                  ),
              })),
            ),
            Effect.provideServiceEffect(
              LibraryStore,
              Effect.map(LibraryStore, (store) => ({
                ...store,
                publish: (next: Parameters<typeof store.publish>[0], base: typeof next) =>
                  Effect.gen(function* () {
                    publishes++;
                    if (publishes === gates.failPublish)
                      return yield* new InvalidLibraryState({
                        path: home.statePath,
                        detail: "Test refusal of a Library publication",
                      });
                    yield* store.publish(next, base);
                    if (publishes === 1) yield* Effect.orDie(gates.published ?? Effect.void);
                  }),
              })),
            ),
            Effect.provideServiceEffect(
              FileSystem.FileSystem,
              Effect.map(FileSystem.FileSystem, (files) => ({
                ...files,
                readFileString: (path: string, encoding?: string) =>
                  Effect.andThen(
                    Effect.sync(() => {
                      if (path === globalLock) scans++;
                    }),
                    files.readFileString(path, encoding),
                  ),
                rename: (from: string, to: string) =>
                  Effect.andThen(gates.rename?.(from, to) ?? Effect.void, files.rename(from, to)),
              })),
            ),
            Effect.provide(interaction.layer),
          ),
        ),
      );
      if (Exit.isSuccess(exit)) assert.isTrue(Schema.is(outputContracts.setup.schema)(exit.value));
      return { exit, scans, interaction };
    });
  return {
    fs,
    root,
    home,
    path: (name: string) => join(agentRoot, name),
    /** The Library home, the agent roots with their backups, and the skills.sh state. */
    disk: [home.home, join(root, ".codex"), options.skillsStateHome],
    setup,
  };
});

/** Each changed path relative to the fixture root; a recovery folder's random name reads `*`. */
const changedPaths = (root: string, changes: DiskDiff) => {
  const show = ({ path }: { path: readonly string[] }) =>
    relative(root, join(...path)).replace(/^library\/removed\/[^/]+/, "library/removed/*");
  return {
    created: changes.created.map(show),
    deleted: changes.deleted.map(show),
    changed: changes.changed.map(show),
  };
};

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

const refuseRename = (path: string) =>
  Effect.fail(
    systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "rename",
      pathOrDescriptor: path,
    }),
  );

const Receipt = Schema.fromJsonString(
  Schema.Struct({
    entries: Schema.Array(
      Schema.Struct({ path: Schema.String, recoveryPath: Schema.String, moved: Schema.Boolean }),
    ),
  }),
);

const readReceipt = Effect.fn("Test.readSetupReceipt")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const [directory] = yield* fs.readDirectory(join(home, "removed"));
  return yield* Schema.decodeUnknownEffect(Receipt)(
    yield* fs.readFileString(join(home, "removed", directory!, "receipt.json")),
  );
});

const holds = (changes: DiskDiff, bytes: string) =>
  changes.created.some(
    ({ path, after }) =>
      path[1] === "originals" &&
      after.type === "file" &&
      after.content === `base64:${Buffer.from(bytes).toString("base64")}`,
  );

it.effect("declining or previewing the plan applies nothing after one scan", () =>
  Effect.gen(function* () {
    for (const decline of [true, false]) {
      const f = yield* fixture({ machine: true });
      const before = yield* captureDisk(f.disk);
      const { exit, scans } = decline
        ? yield* f.setup([["alpha", "remove\0gamma"], false])
        : yield* f.setup([], {}, { dryRun: true });
      assert.isTrue(Exit.isSuccess(exit));
      assert.deepStrictEqual(yield* diskChanges(before), noDiskChanges);
      assert.strictEqual(scans, 1);
    }
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("declining over a legacy Library writes only the loader's backed-up migration", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const legacy = yield* f.fs.readFileString(
      join(import.meta.dirname, "../../skit/test/fixtures/library-state/v4-well-known-subset.json"),
    );
    yield* f.fs.writeFileString(f.home.statePath, legacy);
    const before = yield* captureDisk(f.disk);
    const { exit } = yield* f.setup([["alpha"], false]);
    assert.isTrue(Exit.isSuccess(exit));
    const paths = changedPaths(f.root, yield* diskChanges(before));
    assert.deepStrictEqual(paths.deleted, []);
    assert.deepStrictEqual(paths.changed, ["library/state.json"]);
    assert.strictEqual(paths.created.length, 1);
    assert.match(paths.created[0]!, /^library\/state\.json\.v4\.backup-/);
    assert.deepStrictEqual(
      JSON.parse(yield* f.fs.readFileString(join(f.root, paths.created[0]!))),
      JSON.parse(legacy),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("non-interactive setup with a work dir saves machine configuration while observing", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const work = join(f.root, "work");
    yield* f.fs.makeDirectory(work);
    const before = yield* captureDisk(f.disk);
    const { exit, scans } = yield* f.setup([], {}, { interactive: false, workDirFlag: work });
    assert.isTrue(Exit.isSuccess(exit));
    if (Exit.isSuccess(exit)) {
      assert.isTrue(exit.value.machineConfig.persisted);
      assert.deepStrictEqual(exit.value.machineConfig.repositoryRoots, [work]);
    }
    assert.deepStrictEqual(changedPaths(f.root, yield* diskChanges(before)), {
      created: [],
      deleted: [],
      changed: ["library/machine.json"],
    });
    assert.strictEqual(scans, 1);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a selected file changed after approval fails stale before any effect", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const before = yield* captureDisk(f.disk);
    const { exit, scans } = yield* f.setup([["alpha", "remove\0gamma"], true], {
      approved: f.fs.writeFileString(
        join(f.path("alpha"), "SKILL.md"),
        skillBytes("alpha", "changed after approval"),
      ),
    });
    assert.instanceOf(failure(exit), SetupPlanStale);
    assert.deepStrictEqual(changedPaths(f.root, yield* diskChanges(before)), {
      created: [],
      deleted: [],
      changed: [".codex/skills/alpha/SKILL.md"],
    });
    assert.strictEqual(scans, 2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// BUG characterization: the setup-apply refactor scans once after approval, which flips this to 2
// (the preview and the one apply-time scan). Today revalidation, the custody stage's own
// observation and revalidation, and the closing verification each rescan.
it.effect("BUG: an approved apply runs a full discovery scan per stage", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const { exit, scans } = yield* f.setup([["alpha"], true]);
    assert.isTrue(Exit.isSuccess(exit));
    assert.deepStrictEqual(
      (yield* f.home.durable).skills.map((skill) => skill.name),
      ["alpha"],
    );
    assert.strictEqual(scans, 5);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// BUG characterization: the custody stage observes again after the removals and revalidates
// against that new plan, so consent silently follows bytes changed after approval. The
// setup-apply refactor keeps the approved plan ID, which flips this to SetupPlanStale with alpha
// left out of the Library.
it.effect("BUG: a stage's own observation refreshes consent for bytes changed after approval", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const changed = skillBytes("alpha", "changed after approval");
    const before = yield* captureDisk(f.disk);
    const { exit } = yield* f.setup([["alpha", "remove\0gamma"], true], {
      rename: (from) =>
        from === f.path("gamma")
          ? f.fs.writeFileString(join(f.path("alpha"), "SKILL.md"), changed)
          : Effect.void,
    });
    assert.isTrue(Exit.isSuccess(exit));
    assert.deepStrictEqual(
      (yield* f.home.durable).skills.map((skill) => skill.name),
      ["alpha"],
    );
    assert.isTrue(holds(yield* diskChanges(before), changed));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// BUG characterization: custody plans each selection from the disk as it is then, so a selected
// copy changed after an earlier selection committed is retained as changed. The setup-apply
// refactor checks each selection against the approved identity before touching bytes, which flips
// this to a stale failure with beta left out of the Library.
it.effect("BUG: a selected copy changed after the first additive stage is still retained", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const changed = skillBytes("beta", "changed after the first stage");
    const before = yield* captureDisk(f.disk);
    const { exit } = yield* f.setup([["alpha", "beta"], true], {
      published: f.fs.writeFileString(join(f.path("beta"), "SKILL.md"), changed),
    });
    assert.isTrue(Exit.isSuccess(exit));
    assert.deepStrictEqual((yield* f.home.durable).skills.map((skill) => skill.name).sort(), [
      "alpha",
      "beta",
    ]);
    assert.isTrue(holds(yield* diskChanges(before), changed));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// BUG characterization: removals run first, so a failed additive stage leaves the copy moved to
// recovery. Machine identity and orphan originals are also written before the failure. The
// setup-apply refactor runs additive stages first, which flips this to gamma left in place.
it.effect("BUG: a failed additive stage after removals leaves the removals applied", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: false });
    const before = yield* captureDisk(f.disk);
    const { exit } = yield* f.setup([["alpha", "remove\0gamma"], true], { failPublish: 1 });
    assert.instanceOf(failure(exit), InvalidLibraryState);
    const changes = yield* diskChanges(before);
    const paths = changedPaths(f.root, changes);
    assert.deepStrictEqual(paths.changed, []);
    assert.deepStrictEqual(paths.deleted, [".codex/skills/gamma", ".codex/skills/gamma/SKILL.md"]);
    assert.deepStrictEqual(
      [...new Set(paths.created.map((path) => path.split("/").slice(0, 2).join("/")))],
      ["library/machine.json", "library/originals", "library/removed"],
    );
    // The moved copy keeps its bytes and mode: nothing that cannot be reproduced is lost.
    assert.deepStrictEqual(
      changes.created.find(({ path }) => path.at(-2) === "1-gamma" && path.at(-1) === "SKILL.md")
        ?.after,
      changes.deleted.find(({ path }) => path.at(-1) === "SKILL.md")?.before,
    );
    assert.deepStrictEqual(
      (yield* readReceipt(f.home.home)).entries.map((entry) => [entry.path, entry.moved]),
      [[f.path("gamma"), true]],
    );
    assert.isFalse(yield* f.fs.exists(f.home.statePath));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a failed removal move leaves a moved prefix, the rest in place, and a receipt", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const before = yield* captureDisk(f.disk);
    let moves = 0;
    const { exit } = yield* f.setup([["remove\0beta", "remove\0gamma"], true], {
      rename: (from) =>
        from.startsWith(f.path("")) && ++moves === 2 ? refuseRename(from) : Effect.void,
    });
    assert.instanceOf(failure(exit), PlatformError);
    const receipt = yield* readReceipt(f.home.home);
    assert.deepStrictEqual(
      receipt.entries.map((entry) => entry.moved),
      [true, false],
    );
    const [moved, kept] = receipt.entries;
    const paths = changedPaths(f.root, yield* diskChanges(before));
    assert.deepStrictEqual(paths.changed, []);
    assert.deepStrictEqual(paths.deleted, [
      relative(f.root, moved!.path),
      `${relative(f.root, moved!.path)}/SKILL.md`,
    ]);
    assert.isFalse(yield* f.fs.exists(kept!.recoveryPath));
    assert.strictEqual(
      yield* f.fs.readFileString(join(moved!.recoveryPath, "SKILL.md")),
      skillBytes(basename(moved!.path)),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// BUG characterization: the receipt is rewritten after each move, so a failed rewrite leaves a
// moved copy recorded as `moved: false`, and nothing reads the receipt back; recovery must inspect
// both paths. The setup-apply refactor must keep a receipt that documents the durable partial state.
it.effect("BUG: a failed receipt rewrite records a moved copy as not moved", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    let receipts = 0;
    const { exit } = yield* f.setup([["remove\0gamma"], true], {
      rename: (from, to) =>
        basename(to) === "receipt.json" && ++receipts === 2 ? refuseRename(from) : Effect.void,
    });
    assert.instanceOf(failure(exit), PlatformError);
    const [entry] = (yield* readReceipt(f.home.home)).entries;
    assert.isFalse(entry!.moved);
    assert.isFalse(yield* f.fs.exists(entry!.path));
    assert.strictEqual(
      yield* f.fs.readFileString(join(entry!.recoveryPath, "SKILL.md")),
      skillBytes("gamma"),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// BUG characterization: apply reloads the Library at each stage, so a revision another writer
// commits after approval is silently rebased onto. The setup-apply refactor binds the approved
// plan to the Library revision, which flips this to a stale failure with no effects.
it.effect("BUG: a Library change committed after approval is silently rebased onto", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const source = join(f.root, "sources", "delta");
    yield* f.fs.makeDirectory(source, { recursive: true });
    yield* f.fs.writeFileString(join(source, "SKILL.md"), skillBytes("delta"));
    const { exit } = yield* f.setup([["alpha"], true], {
      approved: writingTo(
        f.home.home,
        Effect.gen(function* () {
          yield* retainObservedIn(f.home.home)({
            machineId: testMachineId,
            source: { type: "github", owner: "fixture", repository: "delta" },
            input: source,
            retainedAt: "2026-01-01T00:00:00.000Z",
            skills: [
              {
                name: "delta",
                sourcePath: source,
                relativePath: ".",
                observedHash: yield* deterministicTreeHashEffect(source),
              },
            ],
            observations: [],
          });
        }),
      ).pipe(Effect.scoped, Effect.provide(skitLayer)),
    });
    assert.isTrue(Exit.isSuccess(exit));
    assert.deepStrictEqual((yield* f.home.durable).skills.map((skill) => skill.name).sort(), [
      "alpha",
      "delta",
    ]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
