import { assert, it } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { migratedMachineId } from "../src/library/entity-ids.js";
import { observePathEvidence } from "../src/library/folder-evidence.js";
import { InstalledSkills } from "../src/library/installed-skills.js";
import { reviewInstalledSkillChanges } from "../src/library/installed-skill-review.js";
import { Library } from "../src/library/library.js";
import { planIntent } from "../src/library/plan-changes.js";
import { resumeSetup } from "../src/library/setup.js";
import { routedInstalledSkills } from "../src/library/setup-manage.js";
import {
  OperationStatus,
  type FolderEvidence,
  type SetupStep,
  type StepRouting,
} from "../src/library/store/state-schema.js";
import { skitLayer } from "../src/platform/layer.js";
import { inLibrary, inspectLibrary, libraryLayer } from "./helpers/library-store.js";

const machineId = migratedMachineId("019950c0-4c00-7000-8000-000000000001", "setup-manage-test");
const skill = "---\nname: review\n---\nReview.\n";

/** Renames and links pass `commits` times, then the next crashes, as the process dying would. */
const crashingAfter = (commits: number) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => {
      let left = commits;
      const crash = Effect.suspend(() => (left-- <= 0 ? Effect.die("crash") : Effect.void));
      return {
        ...fs,
        rename: (from: string, to: string) => Effect.andThen(crash, fs.rename(from, to)),
        link: (from: string, to: string) => Effect.andThen(crash, fs.link(from, to)),
      };
    }),
  );

const withLibrary = <A, E, R>(
  home: string,
  use: (library: Library.Interface) => Effect.Effect<A, E, R>,
  fileSystem = crashingAfter(Number.POSITIVE_INFINITY),
) =>
  Effect.gen(function* () {
    const layer = libraryLayer(home).pipe(Layer.provide(fileSystem));
    return yield* use(Context.get(yield* Layer.build(layer), Library.Service));
  });

const evidenceAt = (path: string) =>
  Effect.flatMap(observePathEvidence(path), (evidence) =>
    Option.isSome(evidence) && evidence.value._tag === "Directory"
      ? Effect.succeed(evidence.value)
      : Effect.die(`no folder at ${path}`),
  );

/**
 * A home; a source holding the `review` skill; and an agent's skills folder that already holds
 * an unmanaged copy of the same bytes. Setup imports the source, then manages that copy in place.
 */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-setup-manage-" });
  const home = join(workspace, "home");
  const source = join(workspace, "source", "review");
  const agents = join(workspace, "agents");
  const copy = join(agents, "review");
  for (const folder of [source, copy]) {
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.writeFileString(join(folder, "SKILL.md"), skill);
  }
  const routing: StepRouting = {
    active: ["agents"],
    destinations: [{ scope: { kind: "global" }, destination: "agents", root: agents }],
    readable: [{ scope: { kind: "global" }, harness: "codex", root: agents }],
  };
  const currentHash = yield* deterministicTreeHash(source);
  const imported = (importedAt: string): SetupStep => ({
    _tag: "Import",
    request: {
      machineId,
      source: { type: "local", path: source },
      input: source,
      importedAt,
      skills: [{ name: "review", sourcePath: source, relativePath: ".", currentHash }],
      lockFileEntries: [],
    },
  });
  const manage = (evidence: FolderEvidence): SetupStep => ({
    _tag: "Manage",
    mode: "new",
    routing,
    selections: [
      {
        name: "review",
        mode: "new",
        source: evidence,
        duplicates: Option.none(),
        approvedSymlinks: [],
        approvedCopies: [],
        importFrom: { _tag: "Step", step: 0 },
        currentHash: Option.some(evidence.treeHash),
        equalCopies: [],
        ownership: Option.some({ harnesses: ["codex"], machineId: Option.some(machineId) }),
      },
    ],
  });
  return { fs, home, source, copy, routing, imported, manage };
});

const recordedOperations = (home: string) =>
  Effect.gen(function* () {
    const inspected = yield* inspectLibrary(home);
    return inspected.present
      ? yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(inspected.state.operations)
      : [];
  });

/** The copy is SKIT's now: recorded as installed where it was, with SKIT's marker in it. */
const assertManaged = (home: string, copy: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const inspected = yield* inspectLibrary(home);
    if (!inspected.present) return assert.fail("no Library");
    assert.deepStrictEqual(
      inspected.state.installed_skills.map(({ path, status }) => ({ path, status })),
      [{ path: copy, status: "installed" }],
    );
    assert.isTrue(yield* fs.exists(join(copy, ".skit-ownership.json")));
  });

it.effect("imports a source, then manages the matching copy in place, routed as recorded", () =>
  Effect.gen(function* () {
    const { home, copy, imported, manage } = yield* fixture;
    const steps = [imported("2026-11-04T00:00:00.000Z"), manage(yield* evidenceAt(copy))];

    const result = yield* withLibrary(home, (library) =>
      Effect.flatMap(library.read, (base) => library.setup(steps, { base })),
    );

    assert.strictEqual(result._tag, "Done");
    if (result._tag !== "Done") return;
    assert.deepStrictEqual(
      result.steps.map(({ _tag }) => _tag),
      ["Import", "Manage"],
    );
    yield* assertManaged(home, copy);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// One Import then one Manage commits: the record; the Collection Version and the import's state;
// the Import's Done mark; the managed copy's marker and its state; the Manage Done mark; Done.
it.effect("the Import's Done mark saves what it retained in the Manage step that uses it", () =>
  Effect.gen(function* () {
    const { home, copy, imported, manage } = yield* fixture;
    const steps = [imported("2026-11-04T00:00:00.000Z"), manage(yield* evidenceAt(copy))];
    yield* Effect.exit(
      withLibrary(
        home,
        (library) => Effect.flatMap(library.read, (base) => library.setup(steps, { base })),
        crashingAfter(4),
      ),
    );
    const inspected = yield* inspectLibrary(home);
    if (!inspected.present) return assert.fail("no Library");
    const [operation] = yield* recordedOperations(home);
    if (operation?._tag !== "Pending") return assert.fail("setup is not Pending");
    const retained = {
      _tag: "Retained" as const,
      hash: inspected.state.collection_versions[0]!.hash,
    };
    assert.deepStrictEqual(operation.steps[0]?.after, [retained]);
    assert.deepStrictEqual(operation.steps[1]?.after, [retained]);
    assert.deepStrictEqual(
      operation.steps.map(({ status }) => status),
      ["Done", "Pending"],
    );

    const result = yield* inLibrary(home)(resumeSetup(operation.operationId));

    assert.strictEqual(result._tag, "Done");
    yield* assertManaged(home, copy);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const commits of [5, 7, 8])
  it.effect(`a crash after commit ${commits} of a Manage step is finished by a re-run`, () =>
    Effect.gen(function* () {
      const { home, copy, imported, manage } = yield* fixture;
      const steps = [imported("2026-11-04T00:00:00.000Z"), manage(yield* evidenceAt(copy))];
      const crashed = yield* Effect.exit(
        withLibrary(
          home,
          (library) => Effect.flatMap(library.read, (base) => library.setup(steps, { base })),
          crashingAfter(commits),
        ),
      );
      assert.isTrue(Exit.isFailure(crashed));
      const [operation] = yield* recordedOperations(home);
      if (operation?._tag !== "Pending") return assert.fail("setup is not Pending");

      const result = yield* inLibrary(home)(resumeSetup(operation.operationId));

      assert.strictEqual(result._tag, "Done");
      yield* assertManaged(home, copy);
      assert.deepStrictEqual(yield* recordedOperations(home), [
        OperationStatus.cases.Done.make({ operationId: operation.operationId }),
      ]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

// Library writes SKIT's marker into a managed folder before it records the copy, so a crash
// between the two leaves a folder that is neither as reviewed nor recorded as SKIT's.
it.effect("a crash between the marker and its record stops the re-run, touching nothing", () =>
  Effect.gen(function* () {
    const { fs, home, copy, imported, manage } = yield* fixture;
    const steps = [imported("2026-11-04T00:00:00.000Z"), manage(yield* evidenceAt(copy))];
    yield* Effect.exit(
      withLibrary(
        home,
        (library) => Effect.flatMap(library.read, (base) => library.setup(steps, { base })),
        crashingAfter(6),
      ),
    );
    const [operation] = yield* recordedOperations(home);
    if (operation?._tag !== "Pending") return assert.fail("setup is not Pending");
    const marker = yield* fs.readFileString(join(copy, ".skit-ownership.json"));

    const result = yield* inLibrary(home)(resumeSetup(operation.operationId));

    assert.strictEqual(result._tag, "Stopped");
    if (result._tag !== "Stopped") return;
    assert.deepStrictEqual(
      { tag: result.reason._tag, step: result.reason.step },
      { tag: "EvidenceDiffers", step: 1 },
    );
    assert.strictEqual(yield* fs.readFileString(join(copy, ".skit-ownership.json")), marker);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a re-run stops when the copy to manage changed after the record", () =>
  Effect.gen(function* () {
    const { fs, home, copy, imported, manage } = yield* fixture;
    const steps = [imported("2026-11-04T00:00:00.000Z"), manage(yield* evidenceAt(copy))];
    yield* Effect.exit(
      withLibrary(
        home,
        (library) => Effect.flatMap(library.read, (base) => library.setup(steps, { base })),
        crashingAfter(4),
      ),
    );
    const [operation] = yield* recordedOperations(home);
    if (operation === undefined) return assert.fail("no operation recorded");
    yield* fs.writeFileString(join(copy, "notes.md"), "the user's edit\n");

    const result = yield* inLibrary(home)(resumeSetup(operation.operationId));

    assert.strictEqual(result._tag, "Stopped");
    if (result._tag !== "Stopped") return;
    assert.deepStrictEqual(
      { tag: result.reason._tag, step: result.reason.step },
      { tag: "EvidenceDiffers", step: 1 },
    );
    assert.isFalse(yield* fs.exists(join(copy, ".skit-ownership.json")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

/** What updating every copy would do now, routed as `routing` records. */
const reviewUpdate = (home: string, routing: StepRouting) =>
  inLibrary(home)(
    Effect.gen(function* () {
      const inspected = yield* inspectLibrary(home);
      if (!inspected.present) return yield* Effect.die("no Library");
      const files = yield* routedInstalledSkills(routing);
      return reviewInstalledSkillChanges(
        yield* planIntent({ _tag: "Update" }, { base: inspected.state }).pipe(
          Effect.provideService(InstalledSkills.Service, files),
        ),
      );
    }),
  );

/** The managed fixture, its source then edited and imported again: the copy has an update. */
const updateFixture = Effect.gen(function* () {
  const fixed = yield* fixture;
  const { fs, home, source, copy, imported, manage, routing } = fixed;
  const steps = [imported("2026-11-04T00:00:00.000Z"), manage(yield* evidenceAt(copy))];
  yield* withLibrary(home, (library) =>
    Effect.flatMap(library.read, (base) => library.setup(steps, { base })),
  );
  yield* fs.writeFileString(join(source, "SKILL.md"), `${skill}Now with more.\n`);
  const currentHash = yield* deterministicTreeHash(source);
  yield* withLibrary(home, (library) =>
    library.import.collection({
      machineId,
      source: { type: "local", path: source },
      input: source,
      importedAt: "2026-11-05T00:00:00.000Z",
      skills: [{ name: "review", sourcePath: source, relativePath: ".", currentHash }],
      lockFileEntries: [],
    }),
  );
  const changes = yield* reviewUpdate(home, routing);
  assert.deepStrictEqual(
    changes.map(({ path, status }) => ({ path, status })),
    [{ path: copy, status: "incoming-update" }],
  );
  const update: SetupStep = {
    _tag: "Update",
    routing,
    importedAt: "2026-11-05T01:00:00.000Z",
    versionChoices: [],
    changes: changes.map((change) => ({
      installedSkillId: Option.fromUndefinedOr(change.installedSkillId),
      skillId: change.skillId,
      name: change.name,
      path: change.path,
      destination: change.destination,
      baselineHash: Option.fromUndefinedOr(change.baselineHash),
      currentHash: Option.fromUndefinedOr(change.currentHash),
      desiredHash: Option.fromUndefinedOr(change.desiredHash),
      desiredVersionId: Option.fromUndefinedOr(change.desiredVersionId),
      evidence: change.evidence,
      status: change.status,
      metadataChanged: change.metadataChanged,
    })),
  };
  return { ...fixed, update };
});

it.effect("updates the reviewed copies, routed as recorded", () =>
  Effect.gen(function* () {
    const { fs, home, copy, update } = yield* updateFixture;

    const result = yield* withLibrary(home, (library) =>
      Effect.flatMap(library.read, (base) => library.setup([update], { base })),
    );

    assert.strictEqual(result._tag, "Done");
    if (result._tag !== "Done") return;
    const [step] = result.steps;
    assert.deepStrictEqual(
      step?._tag === "Update" ? step.changes.map(({ path, status }) => ({ path, status })) : [],
      [{ path: copy, status: "updated" }],
    );
    assert.include(yield* fs.readFileString(join(copy, "SKILL.md")), "Now with more.");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// An Update step commits: the record, the old copy to its backup, the new copy, the Library's
// record of it, the step's Done mark, then Done.
it.effect("a crash after the update was saved is finished by a re-run that accepts it", () =>
  Effect.gen(function* () {
    const { fs, home, copy, update } = yield* updateFixture;
    const crashed = yield* Effect.exit(
      withLibrary(
        home,
        (library) => Effect.flatMap(library.read, (base) => library.setup([update], { base })),
        crashingAfter(4),
      ),
    );
    assert.isTrue(Exit.isFailure(crashed));
    const [operation] = (yield* recordedOperations(home)).filter(
      (recorded) => recorded._tag === "Pending",
    );
    if (operation === undefined) return assert.fail("setup is not Pending");
    assert.include(yield* fs.readFileString(join(copy, "SKILL.md")), "Now with more.");

    const result = yield* inLibrary(home)(resumeSetup(operation.operationId));

    assert.strictEqual(result._tag, "Done");
    if (result._tag !== "Done") return;
    const [step] = result.steps;
    assert.deepStrictEqual(
      step?._tag === "Update" ? step.changes.map(({ path, status }) => ({ path, status })) : [],
      [{ path: copy, status: "unchanged" }],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an Update step stops when a copy changed after it was reviewed", () =>
  Effect.gen(function* () {
    const { fs, home, copy, update } = yield* updateFixture;
    yield* fs.writeFileString(join(copy, "SKILL.md"), "the user's edit\n");

    const result = yield* withLibrary(home, (library) =>
      Effect.flatMap(library.read, (base) => library.setup([update], { base })),
    );

    assert.strictEqual(result._tag, "Stopped");
    if (result._tag !== "Stopped") return;
    assert.deepStrictEqual(
      { tag: result.reason._tag, step: result.reason.step },
      { tag: "EvidenceDiffers", step: 0 },
    );
    assert.strictEqual(yield* fs.readFileString(join(copy, "SKILL.md")), "the user's edit\n");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("retires an approved link to the managed copy once SKIT's copy is readable", () =>
  Effect.gen(function* () {
    const { fs, home, copy, imported, manage, routing } = yield* fixture;
    const claude = join(copy, "..", "..", "claude");
    yield* fs.makeDirectory(claude, { recursive: true });
    yield* fs.symlink(copy, join(claude, "review"));
    const observed = yield* observePathEvidence(join(claude, "review"));
    const link = Option.getOrUndefined(observed);
    if (link?._tag !== "SymbolicLink") return assert.fail("no link evidence");
    const step = manage(yield* evidenceAt(copy));
    if (step._tag !== "Manage" || step.mode !== "new") return assert.fail("not a Manage step");
    const withLink: SetupStep = {
      ...step,
      routing: {
        ...routing,
        readable: [
          ...routing.readable,
          { scope: { kind: "global" }, harness: "claude-code", root: claude },
          { scope: { kind: "global" }, harness: "claude-code", root: join(copy, "..") },
        ],
      },
      selections: step.selections.map((selection) => ({
        ...selection,
        duplicates: Option.some("retire-aliases" as const),
        approvedSymlinks: [link],
      })),
    };

    const result = yield* withLibrary(home, (library) =>
      Effect.flatMap(library.read, (base) =>
        library.setup([imported("2026-11-04T00:00:00.000Z"), withLink], { base }),
      ),
    );

    assert.strictEqual(result._tag, "Done");
    if (result._tag !== "Done") return;
    yield* assertManaged(home, copy);
    const directory = join(home, "removed", result.operationId, "step-2-1");
    assert.deepStrictEqual(result.recoveryDirectories, [directory]);
    assert.isFalse(yield* fs.exists(join(claude, "review")));
    assert.strictEqual(yield* fs.readLink(join(directory, "1-review")), copy);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a re-run imports a chosen local edit once", () =>
  Effect.gen(function* () {
    const { fs, home, copy, routing } = yield* updateFixture;
    yield* fs.writeFileString(join(copy, "SKILL.md"), `${skill}The user's own line.\n`);
    const changes = yield* reviewUpdate(home, routing);
    const [competing] = changes;
    if (competing?.status !== "competing") return assert.fail("the copy is not competing");
    const update: SetupStep = {
      _tag: "Update",
      routing,
      importedAt: "2026-11-05T02:00:00.000Z",
      versionChoices: [
        { skillId: competing.skillId, version: "local", path: Option.some(competing.path) },
      ],
      changes: changes.map((change) => ({
        installedSkillId: Option.fromUndefinedOr(change.installedSkillId),
        skillId: change.skillId,
        name: change.name,
        path: change.path,
        destination: change.destination,
        baselineHash: Option.fromUndefinedOr(change.baselineHash),
        currentHash: Option.fromUndefinedOr(change.currentHash),
        desiredHash: Option.fromUndefinedOr(change.desiredHash),
        desiredVersionId: Option.fromUndefinedOr(change.desiredVersionId),
        evidence: change.evidence,
        status: change.status,
        metadataChanged: change.metadataChanged,
      })),
    };
    // The record and the edit's import are the first four commits: the crash comes before the
    // update itself writes anything.
    yield* Effect.exit(
      withLibrary(
        home,
        (library) => Effect.flatMap(library.read, (base) => library.setup([update], { base })),
        crashingAfter(4),
      ),
    );
    const edits = Effect.map(inspectLibrary(home), (inspected) =>
      inspected.present
        ? inspected.state.imports.filter((sourceImport) => sourceImport.kind === "edit").length
        : 0,
    );
    assert.strictEqual(yield* edits, 1);
    const [operation] = (yield* recordedOperations(home)).filter(
      (recorded) => recorded._tag === "Pending",
    );
    if (operation === undefined) return assert.fail("setup is not Pending");

    const result = yield* inLibrary(home)(resumeSetup(operation.operationId));

    assert.strictEqual(result._tag, "Done");
    assert.strictEqual(yield* edits, 1);
    assert.include(yield* fs.readFileString(join(copy, "SKILL.md")), "The user's own line.");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
