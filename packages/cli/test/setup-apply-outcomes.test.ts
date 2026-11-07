import { recoveryInspection, recoveryList } from "./helpers/recovery.js";
import { withLibraryOwner } from "./helpers/library-owner.js";
import { basename, join, relative } from "node:path";
import { Effect, Exit, FileSystem, Option, Schema } from "effect";
import { PlatformError, systemError } from "effect/PlatformError";
import { assert, it } from "@effect/vitest";
import { LibraryState } from "@smolai/skit-core/library";
import * as Library from "@smolai/skit-core/library";
import { skitLayer } from "@smolai/skit-core/platform";
import { withSandboxDenying } from "./helpers/sandbox.js";
import { SetupResult, SetupPlanStale, SetupStopped } from "@smolai/skit-core/library/setup";
import { setupCommand } from "../src/library/setup.js";
import {
  makeScriptedInteraction,
  type ScriptedAnswer,
} from "../src/storybook/interaction-recorder.js";
import { Prompter } from "../src/terminal/prompter.js";
import { setupPrompts } from "../src/library/setup/steps.js";

import { captureDisk, diskChanges, noDiskChanges, type DiskDiff } from "./helpers/disk-snapshot.js";
import {
  deterministicTreeHash,
  initializeLibraryMachine,
  libraryHome,
  importCollectionIn,
  scratch,
  testMachineId,
  writingTo,
} from "./helpers/library-home.js";

// Acceptance oracle for guided `skit setup` apply: docs/setup-apply-outcomes.md.

const skillBytes = (name: string, body = `${name} body`) =>
  `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${body}\n`;

/** Explicit points in the apply where a test changes the world; never a timer. */
interface Gates {
  /** Runs once the confirmation prompt has approved the plan. */
  readonly approved?: Effect.Effect<void, unknown>;
  /** Runs once the first Library state has replaced state.json. */
  readonly published?: Effect.Effect<void, unknown>;
  /** Refuses a publication selected by its domain state, independently of checkpoint count. */
  readonly refusePublication?: (state: LibraryState) => boolean;
  readonly directory?: (path: string) => Effect.Effect<void>;
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
  const setup = (
    answers: readonly ScriptedAnswer[],
    gates: Gates = {},
    flags: { interactive?: boolean; dryRun?: boolean; workDirFlag?: string } = {},
  ) =>
    Effect.gen(function* () {
      // Each complete scan reads the global skills.sh lock once. Count that real IO,
      // including an absent lock, rather than introducing a service to substitute the scan.
      let scans = 0;
      let approvedAt: number | undefined;
      let announcedPublication = false;
      const interaction = yield* makeScriptedInteraction(answers);
      const exit = yield* Effect.exit(
        home.owned(
          setupCommand({
            options,
            interactive: flags.interactive ?? true,
            dryRun: flags.dryRun ?? false,
            ...(flags.workDirFlag ? { workDirFlag: flags.workDirFlag } : {}),
            manageOptions: { installOptions: home.installOptions },
          }).pipe(
            withLibraryOwner(home.inventory),
            Effect.provideServiceEffect(
              Prompter,
              Effect.map(Prompter, (prompter) => ({
                ...prompter,
                confirm: (message: string) =>
                  Effect.tap(prompter.confirm(message), (approved) =>
                    approved && message === setupPrompts.confirm
                      ? Effect.andThen(
                          Effect.sync(() => {
                            approvedAt = scans;
                          }),
                          Effect.orDie(gates.approved ?? Effect.void),
                        )
                      : Effect.void,
                  ),
              })),
            ),
            Effect.provideServiceEffect(
              FileSystem.FileSystem,
              Effect.map(FileSystem.FileSystem, (files) => ({
                ...files,
                readFileString: (...args: Parameters<typeof files.readFileString>) =>
                  Effect.suspend(() => {
                    if (args[0] === join(options.skillsStateHome, "skills", ".skill-lock.json"))
                      scans++;
                    return files.readFileString(...args);
                  }),
                makeDirectory: (...args: Parameters<typeof files.makeDirectory>) =>
                  Effect.gen(function* () {
                    yield* gates.directory?.(args[0]) ?? Effect.void;
                    return yield* files.makeDirectory(...args);
                  }),
                rename: (from: string, to: string) =>
                  Effect.gen(function* () {
                    yield* gates.rename?.(from, to) ?? Effect.void;
                    if (to !== home.statePath) return yield* files.rename(from, to);
                    const state = yield* Schema.decodeUnknownEffect(
                      Schema.fromJsonString(LibraryState),
                    )(yield* files.readFileString(from)).pipe(Effect.orDie);
                    if (gates.refusePublication?.(state)) return yield* refuseRename(to);
                    yield* files.rename(from, to);
                    if (!announcedPublication) {
                      announcedPublication = true;
                      yield* Effect.orDie(gates.published ?? Effect.void);
                    }
                  }),
              })),
            ),
            Effect.provide(interaction.layer),
          ),
        ),
      );
      if (Exit.isSuccess(exit)) assert.isTrue(Schema.is(SetupResult)(exit.value));
      return {
        exit,
        scans,
        scansAfterApproval: approvedAt === undefined ? undefined : scans - approvedAt,
        interaction,
      };
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

const MoveRecord = Schema.fromJsonString(
  Schema.Struct({
    entries: Schema.Array(Schema.Struct({ path: Schema.String, recoveryPath: Schema.String })),
  }),
);

const readMoveRecord = Effect.fn("Test.readSetupMoveRecord")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const [directory] = yield* fs.readDirectory(join(home, "removed"));
  for (const batch of yield* fs.readDirectory(join(home, "removed", directory!))) {
    if ((yield* fs.stat(join(home, "removed", directory!, batch))).type !== "Directory") continue;
    const path = join(home, "removed", directory!, batch, "receipt.json");
    if (yield* fs.exists(path))
      return yield* Schema.decodeUnknownEffect(MoveRecord)(yield* fs.readFileString(path));
  }
  return yield* Effect.die(new Error("No removal move record was written"));
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

it.effect(
  "a foreign record setup would forget changes only the loader's backed-up migration until confirmed",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ machine: true });
      const legacy = yield* f.fs.readFileString(
        join(
          import.meta.dirname,
          "../../skit/test/fixtures/library-state/v4-well-known-subset.json",
        ),
      );
      yield* f.fs.writeFileString(f.home.statePath, legacy);
      const before = yield* captureDisk(f.disk);
      // The record's folder is gone and no route wants it here: applying would forget it, and
      // install the copies the Library wants where nothing is installed yet.
      const { exit } = yield* f.setup([["alpha"], false]);
      assert.isTrue(Exit.isSuccess(exit));
      if (Exit.isSuccess(exit))
        assert.deepStrictEqual(
          exit.value.changes?.map((fact) => [fact.path, fact.status]),
          [
            ["/skills/review", "uninstall"],
            [f.path("review"), "install"],
            ["/workspace/.agents/skills/review", "install"],
          ],
        );
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

it.effect("non-interactive setup with a work dir records a guarded settings-only operation", () =>
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
    // The Library records the setup, with no steps; the settings save under its operation ID.
    assert.deepStrictEqual(changedPaths(f.root, yield* diskChanges(before)), {
      created: ["library/audit.jsonl", "library/state.json"],
      deleted: [],
      changed: ["library/machine.json"],
    });
    // The review's own scan, then the revalidation under apply; the apply reports its scan back.
    assert.strictEqual(scans, 2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a selected file changed after approval fails stale before any effect", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const before = yield* captureDisk(f.disk);
    const { exit, scansAfterApproval } = yield* f.setup([["alpha", "remove\0gamma"], true], {
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
    assert.strictEqual(scansAfterApproval, 1);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// One scan after approval however many stages run: here machine identity, ownership and a removal.
// The stages work from that scan and never observe again.
it.effect("an approved apply scans once after approval, whatever stages it runs", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: false });
    const { exit, scans, scansAfterApproval } = yield* f.setup([["alpha", "remove\0gamma"], true]);
    assert.isTrue(Exit.isSuccess(exit));
    assert.deepStrictEqual(
      (yield* f.home.durable).skills.map((skill) => skill.name),
      ["alpha"],
    );
    assert.isFalse(yield* f.fs.exists(f.path("gamma")));
    assert.strictEqual(scansAfterApproval, 1);
    assert.strictEqual(scans, 2);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// No step observes again, so a selected copy changed after the apply-time scan, here while machine
// identity is written ahead of the steps, cannot pass as approved: its bytes are checked when its
// step is recorded, and nothing reaches the Library.
it.effect("bytes changed between the apply-time scan and a later stage fail stale", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: false });
    const changed = skillBytes("alpha", "changed after approval");
    const before = yield* captureDisk(f.disk);
    const { exit } = yield* f.setup([["alpha", "remove\0gamma"], true], {
      rename: (_from, to) =>
        basename(to) === "machine.json"
          ? f.fs.writeFileString(join(f.path("alpha"), "SKILL.md"), changed)
          : Effect.void,
    });
    assert.instanceOf(failure(exit), Library.StalePlan);
    assert.strictEqual((yield* f.home.snapshot)._tag, "Absent");
    const changes = yield* diskChanges(before);
    assert.isFalse(holds(changes, changed));
    assert.deepStrictEqual(changedPaths(f.root, changes), {
      created: ["library/machine.json"],
      deleted: [],
      changed: [".codex/skills/alpha/SKILL.md"],
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Preparation validates the whole recorded input before creating directories or importing any
// selected copy. An edited selection stops the attempt with no earlier selection retained.
it.effect("a selected copy changed after the steps are recorded stops the setup", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const changed = skillBytes("beta", "changed after the first stage");
    const before = yield* captureDisk(f.disk);
    const { exit } = yield* f.setup([["alpha", "beta", "remove\0gamma"], true], {
      published: f.fs.writeFileString(join(f.path("beta"), "SKILL.md"), changed),
    });
    assert.instanceOf(failure(exit), SetupStopped);
    assert.deepStrictEqual(
      (yield* f.home.durable).skills.map((skill) => skill.name),
      [],
    );
    assert.isFalse(holds(yield* diskChanges(before), changed));
    assert.isTrue(yield* f.fs.exists(join(f.path("gamma"), "SKILL.md")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// A setup whose record cannot be saved writes nothing to the Library; machine identity, which the
// steps are recorded under, may already be written.
it.effect("a setup whose record is refused writes nothing to the Library", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: false });
    const before = yield* captureDisk(f.disk);
    const { exit } = yield* f.setup([["alpha", "remove\0gamma"], true], {
      refusePublication: (state) =>
        state.operations.some((operation) => operation._tag === "Pending"),
    });
    assert.instanceOf(failure(exit), PlatformError);
    assert.deepStrictEqual(changedPaths(f.root, yield* diskChanges(before)), {
      created: ["library/machine.json"],
      deleted: [],
      changed: [],
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Removals run last, so a failed additive step removes nothing. Orphan originals may already be
// written; nothing is lost.
it.effect("a failed additive step leaves every selected removal in place", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: false });
    const before = yield* captureDisk(f.disk);
    const { exit } = yield* f.setup([["alpha", "remove\0gamma"], true], {
      refusePublication: (state) => state.collections.length > 0,
    });
    assert.instanceOf(failure(exit), SetupStopped);
    const paths = changedPaths(f.root, yield* diskChanges(before));
    assert.deepStrictEqual(paths.changed, []);
    assert.deepStrictEqual(paths.deleted, []);
    assert.deepStrictEqual(
      [...new Set(paths.created.map((path) => path.split("/").slice(0, 2).join("/")))],
      ["library/audit.jsonl", "library/machine.json", "library/originals", "library/state.json"],
    );
    assert.deepStrictEqual((yield* f.home.durable).skills, []);
    assert.isTrue(yield* f.fs.exists(join(f.path("gamma"), "SKILL.md")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// A failed root preparation is durable, but no import, ownership or removal stage has run.
it.effect(
  "an unwritable skills directory records its stopped attempt before any stage writes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ machine: false });
      const roots = [join(f.root, ".codex"), join(f.root, "state")];
      const before = yield* captureDisk(roots);
      const { exit } = yield* f
        .setup([["alpha", "remove\0gamma"], true])
        .pipe(withSandboxDenying(join(f.root, ".codex")));
      const error = failure(exit);
      assert.instanceOf(error, SetupStopped);
      assert.include(error.detail, "permission denied");
      assert.deepStrictEqual(yield* diskChanges(before), noDiskChanges);
      const state = yield* f.home.durable;
      assert.deepStrictEqual(state.collections, []);
      assert.deepStrictEqual(state.installed_skills, []);
      assert.deepStrictEqual(state.enabled, []);
      assert.strictEqual(state.operations.length, 1);
      const operation = state.operations[0];
      assert.strictEqual(operation?._tag, "Stopped");
      if (operation?._tag !== "Stopped" || operation.reason._tag !== "StepFailed")
        return yield* Effect.die("Missing stopped preparation");
      assert.strictEqual(operation.reason.error._tag, "SkillsDirectoryNotWritable");
      assert.isFalse(yield* f.fs.exists(join(f.home.home, "originals")));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("every destination directory write has its preparation recorded first", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const root = join(f.root, ".codex", "skills");
    let observed = 0;
    const { exit } = yield* f.setup([["alpha"], true], {
      directory: (path) =>
        Effect.gen(function* () {
          if (path !== root && !path.startsWith(root + "/")) return;
          const state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryState))(
            yield* f.fs.readFileString(f.home.statePath),
          );
          const operation = state.operations.find((operation) => operation._tag === "Pending");
          assert.strictEqual(operation?._tag, "Pending");
          if (operation?._tag !== "Pending")
            return yield* Effect.die("Unrecorded directory creation");
          assert.isTrue(operation.preparation?.roots.some((saved) => saved.path === root));
          observed++;
        }).pipe(Effect.orDie),
    });
    assert.strictEqual(exit._tag, "Success");
    assert.isAbove(observed, 0);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Removal consent covers the approved bytes, not only the directory's identity: a copy edited in
// place after its step was recorded stays where it is, and the setup stops.
it.effect("a removal selection edited after the steps are recorded stays in place", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const changed = skillBytes("gamma", "edited after the first stage");
    const { exit } = yield* f.setup([["alpha", "remove\0gamma"], true], {
      published: f.fs.writeFileString(join(f.path("gamma"), "SKILL.md"), changed),
    });
    assert.instanceOf(failure(exit), SetupStopped);
    assert.strictEqual(yield* f.fs.readFileString(join(f.path("gamma"), "SKILL.md")), changed);
    for (const operationId of yield* recoveryList(f.home.home))
      assert.deepStrictEqual((yield* recoveryInspection(f.home.home, operationId)).entries, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// An ownership marker leaves the tree hash unchanged, so removal checks ownership on its own: a copy
// that gains a marker after the apply-time scan, even an invalid one, is no longer removable.
it.effect("a removal selection that gains an ownership marker after the scan stays in place", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const marker = join(f.path("gamma"), ".skit-ownership.json");
    const { exit } = yield* f.setup([["alpha", "remove\0gamma"], true], {
      published: f.fs.writeFileString(marker, "{}"),
    });
    assert.instanceOf(failure(exit), SetupStopped);
    assert.strictEqual(
      yield* f.fs.readFileString(join(f.path("gamma"), "SKILL.md")),
      skillBytes("gamma"),
    );
    assert.strictEqual(yield* f.fs.readFileString(marker), "{}");
    for (const operationId of yield* recoveryList(f.home.home))
      assert.deepStrictEqual((yield* recoveryInspection(f.home.home, operationId)).entries, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a removal selection whose marker becomes unreadable after the scan stays untouched",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ machine: true });
      const copy = f.path("gamma");
      let before: Effect.Success<ReturnType<typeof captureDisk>> | undefined;
      const { exit } = yield* f.setup([["alpha", "remove\0gamma"], true], {
        published: Effect.gen(function* () {
          yield* f.fs.makeDirectory(join(copy, ".skit-ownership.json"));
          before = yield* captureDisk([copy], { identity: true }).pipe(Effect.provide(skitLayer));
        }),
      });
      assert.instanceOf(failure(exit), SetupStopped);
      assert.deepStrictEqual(yield* captureDisk([copy], { identity: true }), before);
      for (const operationId of yield* recoveryList(f.home.home))
        assert.deepStrictEqual((yield* recoveryInspection(f.home.home, operationId)).entries, []);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Each entry is checked again immediately before its own move, so a later entry replaced while an
// earlier one moves is left alone; the earlier move stays, recorded in the move record.
it.effect("a removal entry replaced during an earlier move stays untouched", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    let replaced: string | undefined;
    const { exit } = yield* f.setup([["remove\0beta", "remove\0gamma"], true], {
      rename: (from) =>
        replaced === undefined && from.startsWith(f.path(""))
          ? Effect.gen(function* () {
              replaced = from === f.path("beta") ? f.path("gamma") : f.path("beta");
              // Keep the displaced inode alive so the replacement cannot reuse its identity.
              yield* f.fs.rename(replaced, `${replaced}.displaced`);
              yield* f.fs.makeDirectory(replaced);
              yield* f.fs.writeFileString(
                join(replaced, "SKILL.md"),
                skillBytes(basename(replaced)),
              );
            }).pipe(Effect.orDie)
          : Effect.void,
    });
    assert.instanceOf(failure(exit), SetupStopped);
    const moveRecord = yield* readMoveRecord(f.home.home);
    const [operation] = yield* recoveryList(f.home.home);
    const inspection = yield* recoveryInspection(f.home.home, operation!);
    assert.deepStrictEqual(
      inspection.entries.map((entry) => entry.status),
      ["saved", "conflict"],
    );
    const [moved, kept] = moveRecord.entries;
    assert.strictEqual(
      yield* f.fs.readFileString(join(moved!.recoveryPath, "SKILL.md")),
      skillBytes(basename(moved!.path)),
    );
    assert.isFalse(yield* f.fs.exists(kept!.recoveryPath));
    assert.strictEqual(
      yield* f.fs.readFileString(join(kept!.path, "SKILL.md")),
      skillBytes(basename(kept!.path)),
    );
    assert.isTrue(yield* f.fs.exists(`${kept!.path}.displaced`));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a failed removal move leaves a moved prefix, the rest in place, and a move record", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const before = yield* captureDisk(f.disk);
    let moves = 0;
    const { exit } = yield* f.setup([["remove\0beta", "remove\0gamma"], true], {
      rename: (from) =>
        from.startsWith(f.path("")) && ++moves === 2 ? refuseRename(from) : Effect.void,
    });
    // The refused rename stops the setup; what moved stays moved.
    assert.instanceOf(failure(exit), SetupStopped);
    const moveRecord = yield* readMoveRecord(f.home.home);
    assert.deepStrictEqual(
      (yield* recoveryInspection(f.home.home, (yield* recoveryList(f.home.home))[0]!)).entries.map(
        (entry) => entry.status,
      ),
      ["saved", "at-original"],
    );
    const [moved, kept] = moveRecord.entries;
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

// A move record is no longer rewritten after moves; an injected second-write failure is unreachable.
it.effect("removal writes one immutable move record before moving files", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    let moveRecordRenames = 0;
    const { exit } = yield* f.setup([["remove\0gamma"], true], {
      rename: (from, to) =>
        basename(to) === "receipt.json" && ++moveRecordRenames > 0
          ? refuseRename(from)
          : Effect.void,
    });
    assert.isTrue(Exit.isSuccess(exit));
    assert.strictEqual(moveRecordRenames, 0); // exclusive publication uses link, not replacement
    const [entry] = (yield* readMoveRecord(f.home.home)).entries;
    assert.isFalse(yield* f.fs.exists(entry!.path));
    assert.strictEqual(
      yield* f.fs.readFileString(join(entry!.recoveryPath, "SKILL.md")),
      skillBytes("gamma"),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

/** Another writer retains `delta` into the same Library, through its own Library services. */
const importDelta = (f: Effect.Success<ReturnType<typeof fixture>>) =>
  Effect.gen(function* () {
    const source = join(f.root, "sources", "delta");
    yield* f.fs.makeDirectory(source, { recursive: true });
    yield* f.fs.writeFileString(join(source, "SKILL.md"), skillBytes("delta"));
    yield* writingTo(
      f.home.home,
      Effect.gen(function* () {
        yield* importCollectionIn(f.home.home)({
          machineId: testMachineId,
          source: { type: "github", owner: "fixture", repository: "delta" },
          input: source,
          importedAt: "2026-01-01T00:00:00.000Z",
          skills: [
            {
              name: "delta",
              sourcePath: source,
              relativePath: ".",
              currentHash: yield* deterministicTreeHash(source),
            },
          ],
          lockFileEntries: [],
        });
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer));

// The approved plan ID covers the Library revision it was planned against.
it.effect("a Library change committed after approval fails stale before any effect", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const { exit } = yield* f.setup([["alpha", "remove\0gamma"], true], {
      approved: importDelta(f),
    });
    assert.instanceOf(failure(exit), SetupPlanStale);
    assert.deepStrictEqual(
      (yield* f.home.durable).skills.map((skill) => skill.name),
      ["delta"],
    );
    assert.isTrue(yield* f.fs.exists(join(f.path("gamma"), "SKILL.md")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
