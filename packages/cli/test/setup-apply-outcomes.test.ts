import { basename, join, relative } from "node:path";
import { Effect, Exit, FileSystem, Option, Schema } from "effect";
import { PlatformError, systemError } from "effect/PlatformError";
import { assert, it } from "@effect/vitest";
import {
  InvalidLibraryState,
  LibraryStore,
  SkillsDirectoryNotWritable,
  skitLayer,
} from "@smolai/skit-core";
import { withSandboxDenying } from "./helpers/sandbox.js";
import { SetupResult } from "../src/workflows/library/setup-contract.js";
import { setupCommand } from "../src/handlers/library/setup.js";
import {
  makeScriptedInteraction,
  type ScriptedAnswer,
} from "../src/presentation/interaction-recorder.js";
import { Prompter } from "../src/presentation/prompter.js";
import { setupPrompts } from "../src/presentation/setup-steps.js";
import {
  inspectRecoveryOperation,
  listRecoveryOperations,
} from "../src/library-application/recovery-moves.js";
import { PlanIsStale } from "../src/library/failures.js";
import { SetupDiscovery, SetupPlanStale } from "../src/workflows/library/setup.js";
import { captureDisk, diskChanges, noDiskChanges, type DiskDiff } from "./helpers/disk-snapshot.js";
import {
  deterministicTreeHash,
  initializeLibraryMachine,
  libraryHome,
  retainObservedIn,
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
  /** Runs once the first Library state has been saved. */
  readonly published?: Effect.Effect<void, unknown>;
  /** Refuses the nth Library state save. */
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
  const setup = (
    answers: readonly ScriptedAnswer[],
    gates: Gates = {},
    flags: { interactive?: boolean; dryRun?: boolean; workDirFlag?: string } = {},
  ) =>
    Effect.gen(function* () {
      // Full discovery scans, counted at the setup scan seam, in all and after approval.
      let scans = 0;
      let approvedAt: number | undefined;
      let publishes = 0;
      const interaction = yield* makeScriptedInteraction(answers);
      const exit = yield* Effect.exit(
        home.owned(
          setupCommand({
            options,
            interactive: flags.interactive ?? true,
            dryRun: flags.dryRun ?? false,
            ...(flags.workDirFlag ? { workDirFlag: flags.workDirFlag } : {}),
            localCustody: { bindings: home.bindings },
          }).pipe(
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
              LibraryStore,
              Effect.map(LibraryStore, (store) => ({
                ...store,
                save: (next: Parameters<typeof store.save>[0], base: typeof next) =>
                  Effect.gen(function* () {
                    publishes++;
                    if (publishes === gates.failPublish)
                      return yield* new InvalidLibraryState({
                        path: home.statePath,
                        detail: "Test refusal of a Library save",
                      });
                    yield* store.save(next, base);
                    if (publishes === 1) yield* Effect.orDie(gates.published ?? Effect.void);
                  }),
              })),
            ),
            Effect.provideServiceEffect(
              SetupDiscovery,
              Effect.map(SetupDiscovery, (discovery) => ({
                collect: (scanned: Parameters<typeof discovery.collect>[0]) =>
                  Effect.andThen(
                    Effect.sync(() => {
                      scans++;
                    }),
                    discovery.collect(scanned),
                  ),
              })),
            ),
            Effect.provideServiceEffect(
              FileSystem.FileSystem,
              Effect.map(FileSystem.FileSystem, (files) => ({
                ...files,
                rename: (from: string, to: string) =>
                  Effect.andThen(gates.rename?.(from, to) ?? Effect.void, files.rename(from, to)),
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

const Receipt = Schema.fromJsonString(
  Schema.Struct({
    entries: Schema.Array(Schema.Struct({ path: Schema.String, recoveryPath: Schema.String })),
  }),
);

const readReceipt = Effect.fn("Test.readSetupReceipt")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const [directory] = yield* fs.readDirectory(join(home, "removed"));
  for (const batch of yield* fs.readDirectory(join(home, "removed", directory!))) {
    if ((yield* fs.stat(join(home, "removed", directory!, batch))).type !== "Directory") continue;
    const path = join(home, "removed", directory!, batch, "receipt.json");
    if (yield* fs.exists(path))
      return yield* Schema.decodeUnknownEffect(Receipt)(yield* fs.readFileString(path));
  }
  return yield* Effect.die(new Error("No removal receipt was published"));
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
  "protected foreign installed skills refuse setup after only the loader's backed-up migration",
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
      const { exit } = yield* f.setup([["alpha"]]);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.match(String(exit.cause), /SetupReconciliationRequired/);
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
    assert.deepStrictEqual(changedPaths(f.root, yield* diskChanges(before)), {
      created: [
        "library/removed",
        "library/removed/*",
        "library/removed/*/changes",
        "library/removed/*/changes/00000001.json",
        "library/removed/*/changes/00000001.published.json",
        "library/removed/*/complete.json",
        "library/removed/*/setup.json",
      ],
      deleted: [],
      changed: ["library/machine.json"],
    });
    assert.strictEqual(scans, 3);
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

// One scan after approval however many stages run: here machine identity, custody and a removal.
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

// No stage observes again, so a selected copy changed after the apply-time scan, here while machine
// identity is written ahead of custody, cannot pass as approved: custody checks its bytes first.
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
    assert.instanceOf(failure(exit), PlanIsStale);
    assert.deepStrictEqual((yield* f.home.durable).skills, []);
    const changes = yield* diskChanges(before);
    assert.isFalse(holds(changes, changed));
    assert.deepStrictEqual(changedPaths(f.root, changes), {
      created: [
        "library/machine.json",
        "library/removed",
        "library/removed/*",
        "library/removed/*/changes",
        "library/removed/*/changes/00000001.json",
        "library/removed/*/changes/00000001.published.json",
        "library/removed/*/setup.json",
      ],
      deleted: [],
      changed: [".codex/skills/alpha/SKILL.md"],
    });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a selected copy changed after the first additive stage fails stale", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const changed = skillBytes("beta", "changed after the first stage");
    const before = yield* captureDisk(f.disk);
    const { exit } = yield* f.setup([["alpha", "beta", "remove\0gamma"], true], {
      published: f.fs.writeFileString(join(f.path("beta"), "SKILL.md"), changed),
    });
    assert.instanceOf(failure(exit), PlanIsStale);
    assert.deepStrictEqual(
      (yield* f.home.durable).skills.map((skill) => skill.name),
      ["alpha"],
    );
    assert.isFalse(holds(yield* diskChanges(before), changed));
    assert.isTrue(yield* f.fs.exists(join(f.path("gamma"), "SKILL.md")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Additive stages run before removals, so a failed additive stage removes nothing. Machine identity
// and orphan originals may already be written; neither loses anything.
it.effect("a failed additive stage leaves every selected removal in place", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: false });
    const before = yield* captureDisk(f.disk);
    const { exit } = yield* f.setup([["alpha", "remove\0gamma"], true], { failPublish: 1 });
    assert.instanceOf(failure(exit), InvalidLibraryState);
    const paths = changedPaths(f.root, yield* diskChanges(before));
    assert.deepStrictEqual(paths.changed, []);
    assert.deepStrictEqual(paths.deleted, []);
    assert.deepStrictEqual(
      [...new Set(paths.created.map((path) => path.split("/").slice(0, 2).join("/")))],
      ["library/machine.json", "library/originals", "library/removed"],
    );
    for (const operationId of yield* listRecoveryOperations(f.home.home))
      assert.deepStrictEqual(
        (yield* inspectRecoveryOperation(f.home.home, operationId)).entries,
        [],
      );
    assert.isFalse(yield* f.fs.exists(f.home.statePath));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Codex's default sandbox keeps `.agents` read-only inside its writable workspace. Setup must refuse
// whole rather than adopt a copy into a Library whose installed skills it cannot then write.
it.effect("an unwritable skills directory fails the apply before any stage writes", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: false });
    const before = yield* captureDisk(f.disk);
    const { exit } = yield* f
      .setup([["alpha", "remove\0gamma"], true])
      .pipe(withSandboxDenying(join(f.root, ".codex")));
    const error = failure(exit);
    assert.instanceOf(error, SkillsDirectoryNotWritable);
    assert.strictEqual(error.root, join(f.root, ".codex", "skills"));
    assert.deepStrictEqual(yield* diskChanges(before), noDiskChanges);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Removal consent covers the approved bytes, not only the directory's identity: a copy edited in
// place after the apply-time scan stays where it is.
it.effect("a removal selection edited after the first additive stage stays in place", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const changed = skillBytes("gamma", "edited after the first stage");
    const { exit } = yield* f.setup([["alpha", "remove\0gamma"], true], {
      published: f.fs.writeFileString(join(f.path("gamma"), "SKILL.md"), changed),
    });
    assert.instanceOf(failure(exit), PlanIsStale);
    assert.strictEqual(yield* f.fs.readFileString(join(f.path("gamma"), "SKILL.md")), changed);
    for (const operationId of yield* listRecoveryOperations(f.home.home))
      assert.deepStrictEqual(
        (yield* inspectRecoveryOperation(f.home.home, operationId)).entries,
        [],
      );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// A custody marker leaves the tree hash unchanged, so removal checks custody on its own: a copy
// that gains a marker after the apply-time scan, even an invalid one, is no longer removable.
it.effect("a removal selection that gains a custody marker after the scan stays in place", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const marker = join(f.path("gamma"), ".skit-ownership.json");
    const { exit } = yield* f.setup([["alpha", "remove\0gamma"], true], {
      published: f.fs.writeFileString(marker, "{}"),
    });
    assert.instanceOf(failure(exit), PlanIsStale);
    assert.strictEqual(
      yield* f.fs.readFileString(join(f.path("gamma"), "SKILL.md")),
      skillBytes("gamma"),
    );
    assert.strictEqual(yield* f.fs.readFileString(marker), "{}");
    for (const operationId of yield* listRecoveryOperations(f.home.home))
      assert.deepStrictEqual(
        (yield* inspectRecoveryOperation(f.home.home, operationId)).entries,
        [],
      );
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
      assert.instanceOf(failure(exit), PlanIsStale);
      assert.deepStrictEqual(yield* captureDisk([copy], { identity: true }), before);
      for (const operationId of yield* listRecoveryOperations(f.home.home))
        assert.deepStrictEqual(
          (yield* inspectRecoveryOperation(f.home.home, operationId)).entries,
          [],
        );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Each entry is checked again immediately before its own move, so a later entry replaced while an
// earlier one moves is left alone; the earlier move stays, recorded in the receipt.
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
    assert.instanceOf(failure(exit), PlanIsStale);
    const receipt = yield* readReceipt(f.home.home);
    const [operation] = yield* listRecoveryOperations(f.home.home);
    const inspection = yield* inspectRecoveryOperation(f.home.home, operation!);
    assert.deepStrictEqual(
      inspection.entries.map((entry) => entry.status),
      ["saved", "conflict"],
    );
    const [moved, kept] = receipt.entries;
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
      (yield* inspectRecoveryOperation(
        f.home.home,
        (yield* listRecoveryOperations(f.home.home))[0]!,
      )).entries.map((entry) => entry.status),
      ["saved", "at-original"],
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

// A receipt is no longer rewritten after moves; an injected second-write failure is unreachable.
it.effect("removal writes one immutable receipt before moving files", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    let receiptRenames = 0;
    const { exit } = yield* f.setup([["remove\0gamma"], true], {
      rename: (from, to) =>
        basename(to) === "receipt.json" && ++receiptRenames > 0 ? refuseRename(from) : Effect.void,
    });
    assert.isTrue(Exit.isSuccess(exit));
    assert.strictEqual(receiptRenames, 0); // exclusive publication uses link, not replacement
    const [entry] = (yield* readReceipt(f.home.home)).entries;
    assert.isFalse(yield* f.fs.exists(entry!.path));
    assert.strictEqual(
      yield* f.fs.readFileString(join(entry!.recoveryPath, "SKILL.md")),
      skillBytes("gamma"),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

/** Another writer retains `delta` into the same Library, through its own Library services. */
const retainDelta = (f: Effect.Success<ReturnType<typeof fixture>>) =>
  Effect.gen(function* () {
    const source = join(f.root, "sources", "delta");
    yield* f.fs.makeDirectory(source, { recursive: true });
    yield* f.fs.writeFileString(join(source, "SKILL.md"), skillBytes("delta"));
    yield* writingTo(
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
              observedHash: yield* deterministicTreeHash(source),
            },
          ],
          observations: [],
        });
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer));

// The approved plan ID covers the Library revision it was planned against.
it.effect("a Library change committed after approval fails stale before any effect", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const { exit } = yield* f.setup([["alpha", "remove\0gamma"], true], {
      approved: retainDelta(f),
    });
    assert.instanceOf(failure(exit), SetupPlanStale);
    assert.deepStrictEqual(
      (yield* f.home.durable).skills.map((skill) => skill.name),
      ["delta"],
    );
    assert.isTrue(yield* f.fs.exists(join(f.path("gamma"), "SKILL.md")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Every save must build on the approved revision or on the apply's own previous one, so a
// Library change between stages is never rebased onto and stops every further effect. The stage
// whose save meets the changed base reports it as its own conflict.
it.effect("a Library change committed after the first additive stage stops the apply", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ machine: true });
    const { exit } = yield* f.setup([["alpha", "beta", "remove\0gamma"], true], {
      published: retainDelta(f),
    });
    assert.propertyVal(failure(exit), "code", "CONFLICT");
    assert.deepStrictEqual((yield* f.home.durable).skills.map((skill) => skill.name).sort(), [
      "alpha",
      "delta",
    ]);
    assert.isTrue(yield* f.fs.exists(join(f.path("gamma"), "SKILL.md")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
