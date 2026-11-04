import { snapshotOf } from "../src/library/snapshot.js";
import { assert, it } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import { migratedMachineId } from "../src/library/entity-ids.js";
import { observePathEvidence } from "../src/library/folder-evidence.js";
import { InstalledSkills } from "../src/library/installed-skills.js";
import { reviewInstalledSkillChanges } from "../src/library/installed-skill-review.js";
import { LibraryState } from "../src/library/library-state.js";
import { Library } from "../src/library/library.js";
import { planIntent } from "../src/library/plan-changes.js";
import { routedInstalledSkills } from "../src/library/routing/recorded.js";
import {
  OperationStatus,
  type FolderEvidence,
  type LinkEvidence,
  type SetupStep,
  type StepRouting,
} from "../src/library/store/state-schema.js";
import { inspectLocalLibraryState } from "../src/library/store/state-file.js";
import { skitLayer } from "../src/platform/layer.js";
import { inLibrary, inspectLibrary, libraryLayer, saveLibrary } from "./helpers/library-store.js";

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

/** Interrupt after a named durable state or filesystem change, independent of write counts. */
const crashingAt = (
  home: string,
  boundary: "intent" | "pending" | "marker" | "installed" | "step" | "backup" | "successor",
) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) => {
      let crashed = false;
      return {
        ...fs,
        rename: (from: string, to: string) =>
          Effect.gen(function* () {
            yield* fs.rename(from, to);
            if (crashed) return;
            let stop = boundary === "marker" && to.endsWith("/.skit-ownership.json");
            stop ||=
              boundary === "backup" &&
              from.endsWith("/review") &&
              to.includes(".skit-backups/pending-");
            stop ||=
              boundary === "successor" && from.includes(".skit-stage-") && to.endsWith("/review");
            if (to === join(home, "state.json")) {
              const state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryState))(
                yield* fs.readFileString(to),
              ).pipe(Effect.orDie);
              const operation = (yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
                state.operations,
              ).pipe(Effect.orDie)).find((item) => item._tag === "Pending");
              if (operation?._tag === "Pending") {
                const step = operation.steps.find(
                  (item) => item.step._tag === "Manage" || item.step._tag === "Update",
                );
                const batch = step?.applies?.at(-1)?.apply;
                stop ||=
                  boundary === "intent" &&
                  !!batch &&
                  state.enabled.length > 0 &&
                  state.installed_skills.length === 0;
                stop ||=
                  boundary === "pending" &&
                  state.installed_skills.some((row) => row.status === "pending");
                stop ||= boundary === "installed" && !!batch && batch.phase._tag === "Done";
                stop ||= boundary === "step" && step?.status === "Done";
              }
            }
            if (stop) {
              crashed = true;
              return yield* Effect.die("crash at " + boundary);
            }
          }),
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

/** Build the Library over `home` as the next SKIT run would: what its startup recovery did. */
const restart = (home: string) => withLibrary(home, (library) => Effect.succeed(library.startup));

/** The operation records in `state.json`, read as a file: building a store would recover them. */
const recordedOperations = (home: string) =>
  Effect.gen(function* () {
    const inspected = yield* inspectLocalLibraryState(home);
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
    const inspected = yield* inspectLocalLibraryState(home);
    if (!inspected.present) return assert.fail("no Library");
    const [operation] = yield* recordedOperations(home);
    if (operation?._tag !== "Pending") return assert.fail("setup is not Pending");
    const retained = {
      _tag: "Retained" as const,
      hash: inspected.state.collection_versions[0]!.hash,
      collectionId: inspected.state.collections[0]!.collection_id,
    };
    assert.deepStrictEqual(operation.steps[0]?.after, [retained]);
    assert.deepStrictEqual(operation.steps[1]?.after, [retained]);
    assert.deepStrictEqual(
      operation.steps.map(({ status }) => status),
      ["Done", "Pending"],
    );

    const startup = yield* restart(home);

    assert.deepStrictEqual(startup, { finished: [operation.operationId], stopped: [] });
    yield* assertManaged(home, copy);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Managing the copy commits: the intent; the copy recorded as pending; SKIT's marker; the copy
// recorded as installed; the Manage step's Done mark.
for (const [boundary, after] of [
  ["intent", "the intent"],
  ["marker", "the marker"],
  ["installed", "the installed record"],
  ["step", "the Done mark"],
] as const)
  it.effect(`a Manage step that crashed after ${after} is finished by a re-run`, () =>
    Effect.gen(function* () {
      const { home, copy, imported, manage } = yield* fixture;
      const steps = [imported("2026-11-04T00:00:00.000Z"), manage(yield* evidenceAt(copy))];
      const crashed = yield* Effect.exit(
        withLibrary(
          home,
          (library) => Effect.flatMap(library.read, (base) => library.setup(steps, { base })),
          crashingAt(home, boundary),
        ),
      );
      assert.isTrue(Exit.isFailure(crashed));
      const [operation] = yield* recordedOperations(home);
      if (operation?._tag !== "Pending") return assert.fail("setup is not Pending");

      const startup = yield* restart(home);

      assert.deepStrictEqual(startup, { finished: [operation.operationId], stopped: [] });
      yield* assertManaged(home, copy);
      assert.deepStrictEqual(
        (yield* recordedOperations(home)).map(({ _tag, operationId }) => ({ _tag, operationId })),
        [{ _tag: "Done", operationId: operation.operationId }],
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

// The Library records a managed copy before writing SKIT's marker into its folder, so a crash
// between the two leaves a recorded copy with no marker yet; the re-run writes it.
it.effect("a crash after the copy is recorded, before its marker, is finished by a re-run", () =>
  Effect.gen(function* () {
    const { fs, home, copy, imported, manage } = yield* fixture;
    const steps = [imported("2026-11-04T00:00:00.000Z"), manage(yield* evidenceAt(copy))];
    yield* Effect.exit(
      withLibrary(
        home,
        (library) => Effect.flatMap(library.read, (base) => library.setup(steps, { base })),
        crashingAt(home, "pending"),
      ),
    );
    const [operation] = yield* recordedOperations(home);
    if (operation?._tag !== "Pending") return assert.fail("setup is not Pending");
    const crashedState = yield* inspectLocalLibraryState(home);
    assert.deepStrictEqual(
      crashedState.present
        ? crashedState.state.installed_skills.map(({ path, status }) => ({ path, status }))
        : [],
      [{ path: copy, status: "pending" }],
    );
    assert.isFalse(yield* fs.exists(join(copy, ".skit-ownership.json")));

    assert.deepStrictEqual(yield* restart(home), {
      finished: [operation.operationId],
      stopped: [],
    });
    yield* assertManaged(home, copy);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a re-run checks the managed folder itself, and stops when it was edited", () =>
  Effect.gen(function* () {
    const { fs, home, copy, imported, manage } = yield* fixture;
    const steps = [imported("2026-11-04T00:00:00.000Z"), manage(yield* evidenceAt(copy))];
    yield* Effect.exit(
      withLibrary(
        home,
        (library) => Effect.flatMap(library.read, (base) => library.setup(steps, { base })),
        crashingAt(home, "installed"),
      ),
    );
    const [operation] = yield* recordedOperations(home);
    if (operation?._tag !== "Pending") return assert.fail("setup is not Pending");
    // The Library records the copy as installed, but the folder no longer holds those bytes.
    yield* fs.writeFileString(join(copy, "SKILL.md"), "the user's edit\n");

    const startup = yield* restart(home);

    assert.deepStrictEqual(startup.finished, []);
    const [stopped] = startup.stopped;
    assert.deepStrictEqual(
      { tag: stopped?.reason._tag, step: stopped?.reason.step },
      { tag: "EvidenceDiffers", step: 1 },
    );
    assert.strictEqual(yield* fs.readFileString(join(copy, "SKILL.md")), "the user's edit\n");
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

    const startup = yield* restart(home);

    assert.deepStrictEqual(startup.finished, []);
    const [result] = startup.stopped;
    if (result === undefined) return assert.fail("not stopped");
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
        yield* planIntent({ _tag: "Update" }, { home, base: snapshotOf(inspected) }).pipe(
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
    const { fs, home, copy, update, routing } = yield* updateFixture;
    const crashed = yield* Effect.exit(
      withLibrary(
        home,
        (library) => Effect.flatMap(library.read, (base) => library.setup([update], { base })),
        crashingAt(home, "installed"),
      ),
    );
    assert.isTrue(Exit.isFailure(crashed));
    const [operation] = (yield* recordedOperations(home)).filter(
      (recorded) => recorded._tag === "Pending",
    );
    if (operation === undefined) return assert.fail("setup is not Pending");
    assert.include(yield* fs.readFileString(join(copy, "SKILL.md")), "Now with more.");

    const startup = yield* restart(home);

    assert.deepStrictEqual(startup, { finished: [operation.operationId], stopped: [] });
    assert.deepStrictEqual(
      (yield* reviewUpdate(home, routing)).map(({ path, status }) => ({ path, status })),
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
    const edits = Effect.map(inspectLocalLibraryState(home), (inspected) =>
      inspected.present
        ? inspected.state.imports.filter((sourceImport) => sourceImport.kind === "edit").length
        : 0,
    );
    assert.strictEqual(yield* edits, 1);
    const [operation] = (yield* recordedOperations(home)).filter(
      (recorded) => recorded._tag === "Pending",
    );
    if (operation === undefined) return assert.fail("setup is not Pending");

    const startup = yield* restart(home);

    assert.deepStrictEqual(startup, { finished: [operation.operationId], stopped: [] });
    assert.strictEqual(yield* edits, 1);
    assert.include(yield* fs.readFileString(join(copy, "SKILL.md")), "The user's own line.");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a Manage step takes its files from the Collection its Import step saved", () =>
  Effect.gen(function* () {
    const { fs, home, source, copy, imported, manage } = yield* fixture;
    // A second Source with identical bytes: its Collection shares the first one's Version.
    const other = join(source, "..", "..", "other", "review");
    yield* fs.makeDirectory(other, { recursive: true });
    yield* fs.writeFileString(join(other, "SKILL.md"), skill);
    const first = imported("2026-11-04T00:00:00.000Z");
    if (first._tag !== "Import") return assert.fail("not an Import step");
    const second: SetupStep = {
      _tag: "Import",
      request: {
        ...first.request,
        source: { type: "local", path: other },
        input: other,
        skills: first.request.skills.map((item) => ({ ...item, sourcePath: other })),
      },
    };
    const managed = manage(yield* evidenceAt(copy));
    if (managed._tag !== "Manage" || managed.mode !== "new") return assert.fail("not Manage");
    const fromSecond: SetupStep = {
      ...managed,
      selections: managed.selections.map((selection) => ({
        ...selection,
        importFrom: { _tag: "Step" as const, step: 1 },
      })),
    };

    const result = yield* withLibrary(home, (library) =>
      Effect.flatMap(library.read, (base) => library.setup([first, second, fromSecond], { base })),
    );

    assert.strictEqual(result._tag, "Done");
    const inspected = yield* inspectLocalLibraryState(home);
    if (!inspected.present) return assert.fail("no Library");
    const { state } = inspected;
    assert.strictEqual(state.collections.length, 2);
    assert.strictEqual(new Set(state.collection_versions.map(({ hash }) => hash)).size, 1);
    const otherCollection = state.imports.find(({ input }) => input.value === other)?.collection_id;
    const installedFrom = state.skills.find(
      ({ skill_id }) => skill_id === state.installed_skills[0]?.skill_id,
    )?.collection_id;
    assert.isDefined(otherCollection);
    assert.strictEqual(installedFrom, otherCollection);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "an ordinary enable that crashed before writing its marker is finished by the next change",
  () =>
    Effect.gen(function* () {
      const { fs, home, source, copy, routing } = yield* fixture;
      const currentHash = yield* deterministicTreeHash(source);
      const imported = yield* withLibrary(home, (library) =>
        library.import.collection({
          machineId,
          source: { type: "local", path: source },
          input: source,
          importedAt: "2026-11-04T00:00:00.000Z",
          skills: [{ name: "review", sourcePath: source, relativePath: ".", currentHash }],
          lockFileEntries: [],
        }),
      );
      // Interrupt at the marker boundary, independent of how many journal checkpoints precede it.
      const change = (
        fileSystem: Layer.Layer<FileSystem.FileSystem, never, FileSystem.FileSystem>,
      ) =>
        inLibrary(home)(
          Effect.gen(function* () {
            const files = yield* routedInstalledSkills(routing);
            const library = yield* Library.make(home).pipe(
              Effect.provideService(InstalledSkills.Service, files),
            );
            const read = yield* library.read;
            if (read._tag !== "Present") return yield* Effect.die("no Library");
            return yield* library.apply(
              yield* library.plan(
                {
                  _tag: "Enabled",
                  changes: [
                    {
                      _tag: "Enable",
                      subject: { _tag: "Collection", id: imported.collection.collection_id },
                      where: [{ kind: "global" }],
                    },
                  ],
                },
                {
                  base: read,
                  approvals: [{ _tag: "Manage", manage: { path: copy, currentHash } }],
                },
              ),
            );
          }),
        ).pipe(Effect.provide(fileSystem));
      const beforeMarker = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs) => ({
          ...fs,
          rename: (from: string, to: string) =>
            to === join(copy, ".skit-ownership.json")
              ? Effect.die("Interrupted before the marker was written")
              : fs.rename(from, to),
        })),
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(change(beforeMarker))));
      const crashed = yield* inspectLocalLibraryState(home);
      assert.deepStrictEqual(
        crashed.present
          ? crashed.state.installed_skills.map(({ path, status }) => ({ path, status }))
          : [],
        [{ path: copy, status: "pending" }],
      );
      assert.isFalse(yield* fs.exists(join(copy, ".skit-ownership.json")));

      // The next change that plans the copy, here updating every copy, writes the marker.
      yield* inLibrary(home)(
        Effect.gen(function* () {
          const files = yield* routedInstalledSkills(routing);
          const library = yield* Library.make(home).pipe(
            Effect.provideService(InstalledSkills.Service, files),
          );
          const read = yield* library.read;
          if (read._tag !== "Present") return yield* Effect.die("no Library");
          yield* library.apply(yield* library.plan({ _tag: "Update" }, { base: read }));
        }),
      );

      yield* assertManaged(home, copy);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Ported from the CLI's manage-existing test: an alias is retired once SKIT's copy is readable,
// however the skills folders are spelled, and a suppressed copy elsewhere does not hold it back.
it.effect(
  "a Manage existing step retires an approved alias despite a suppressed Claude copy and an aliased spelling of the skills folders",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-setup-alias-" }),
      );
      const home = join(workspace, "library");
      const source = join(workspace, "Work", "skills", "review");
      const alias = join(workspace, ".codex", "skills", "review");
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(join(source, "SKILL.md"), skill);
      yield* fs.makeDirectory(join(workspace, ".codex", "skills"), { recursive: true });
      yield* fs.makeDirectory(join(workspace, ".agents", "skills"), { recursive: true });
      yield* fs.makeDirectory(join(workspace, ".claude", "skills"), { recursive: true });
      yield* fs.symlink(source, alias);
      // The same folders, spelled through a link to the workspace.
      const spelled = join(workspace, "home-alias");
      yield* fs.symlink(workspace, spelled);
      const global = { kind: "global" } as const;
      const routing: StepRouting = {
        active: ["agents", "claude"],
        destinations: [
          { scope: global, destination: "agents", root: join(spelled, ".agents", "skills") },
          { scope: global, destination: "claude", root: join(spelled, ".claude", "skills") },
        ],
        readable: [
          { scope: global, harness: "codex", root: join(spelled, ".codex", "skills") },
          { scope: global, harness: "codex", root: join(spelled, ".agents", "skills") },
          { scope: global, harness: "claude-code", root: join(spelled, ".claude", "skills") },
        ],
      };
      const currentHash = yield* deterministicTreeHash(source);
      const setup = (steps: readonly SetupStep[]) =>
        withLibrary(home, (library) =>
          Effect.flatMap(library.read, (base) => library.setup(steps, { base })),
        );
      yield* setup([
        {
          _tag: "Import",
          request: {
            machineId,
            source: { type: "local", path: source },
            input: source,
            importedAt: "2026-11-04T00:00:00.000Z",
            skills: [{ name: "review", sourcePath: source, relativePath: ".", currentHash }],
            lockFileEntries: [],
          },
        },
      ]);
      const imported = yield* inspectLibrary(home);
      if (!imported.present) return assert.fail("no Library");
      const subjectId = imported.state.collections[0]!.collection_id;
      const bind = (
        duplicates: "keep-both" | "retire-aliases",
        approvedSymlinks: readonly LinkEvidence[],
      ) =>
        Effect.map(evidenceAt(source), (evidence): SetupStep => ({
          _tag: "Manage",
          mode: "existing",
          routing,
          selections: [
            {
              name: "review",
              mode: "existing",
              source: evidence,
              duplicates: Option.some(duplicates),
              approvedSymlinks,
              approvedCopies: [],
              subjectId,
              currentHash,
            },
          ],
        }));
      // Enabled with both copies installed, then the Claude copy deleted by its user.
      const enabled = yield* setup([yield* bind("keep-both", [])]);
      assert.strictEqual(enabled._tag, "Done");
      const installed = yield* inspectLibrary(home);
      if (!installed.present) return assert.fail("no Library");
      assert.isTrue(installed.state.installed_skills.some((copy) => copy.destination === "claude"));
      yield* saveLibrary(home, {
        ...installed.state,
        installed_skills: installed.state.installed_skills.map((copy) =>
          copy.destination === "claude"
            ? { ...copy, status: "suppressed", suppression_reason: "native_delete" }
            : copy,
        ),
      });
      const link = Option.getOrUndefined(yield* observePathEvidence(alias));
      if (link?._tag !== "SymbolicLink") return assert.fail("no link evidence");

      const result = yield* setup([yield* bind("retire-aliases", [link])]);

      assert.strictEqual(result._tag, "Done");
      if (result._tag !== "Done") return;
      assert.lengthOf(result.recoveryDirectories, 1);
      assert.deepStrictEqual(result.warnings, []);
      assert.isFalse(yield* fs.exists(alias));
      assert.isTrue(yield* fs.exists(join(workspace, ".agents", "skills", "review", "SKILL.md")));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const boundary of ["backup", "successor"] as const)
  it.effect(`a recorded setup Update resumes after the ${boundary} rename`, () =>
    Effect.gen(function* () {
      const { fs, home, copy, update, routing } = yield* updateFixture;
      const crashed = yield* Effect.exit(
        withLibrary(
          home,
          (library) => Effect.flatMap(library.read, (base) => library.setup([update], { base })),
          crashingAt(home, boundary),
        ),
      );
      assert.isTrue(Exit.isFailure(crashed));
      const [operation] = (yield* recordedOperations(home)).filter(
        (item) => item._tag === "Pending",
      );
      if (operation?._tag !== "Pending") return assert.fail("Missing Pending Update");
      const batch = operation.steps[0]?.applies?.[0]?.apply;
      if (!batch) return assert.fail("Missing recorded installed changes");
      const expected = batch.changes
        .flatMap((change) =>
          change._tag === "Install" || change._tag === "Save" ? [change.row] : [],
        )
        .find((row) => row.path === copy);
      assert.isDefined(expected);
      assert.deepStrictEqual(yield* restart(home), {
        finished: [operation.operationId],
        stopped: [],
      });
      const state = yield* inspectLibrary(home);
      assert.strictEqual(
        state.present &&
          state.state.installed_skills.find((row) => row.path === copy)?.installed_skill_id,
        expected?.installed_skill_id,
      );
      assert.include(yield* fs.readFileString(join(copy, "SKILL.md")), "Now with more.");
      assert.deepStrictEqual(
        (yield* reviewUpdate(home, routing)).map((row) => row.status),
        ["unchanged"],
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
