import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import {
  deterministicTreeHash,
  LibraryActor,
  LibraryStore,
  LibraryAuditLog,
  skitLayer,
  type LibraryState,
} from "@smolai/skit-core";
import {
  confirmLibraryChange,
  openLibrarySession,
  readLibrarySkillContent,
  proposeLibraryEnable,
  proposeLibraryDisable,
  proposeLibraryCollectionChange,
  libraryCollectionScopes,
} from "../src/library-application/session.js";
import {
  initializeLibraryMachine,
  libraryHome,
  retainObservedIn,
  writingTo,
} from "./helpers/library-home.js";

// The TUI and the interactive list confirm Binding changes through the Library session, with no
// command handler above them. Their history must not depend on one.
it.effect("a front end that confirms a Library session change leaves attributed history", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-session-history-" });
    const home = yield* libraryHome({ home: join(root, "home") });
    yield* initializeLibraryMachine(home.home);
    const installed = join(root, "installed", "review");
    yield* fs.makeDirectory(installed, { recursive: true });
    yield* fs.writeFileString(join(installed, "SKILL.md"), "local Skill\n");
    yield* home.owned(
      writingTo(
        home.home,
        retainObservedIn(home.home)({
          source: { type: "local", path: installed },
          input: installed,
          retainedAt: "2026-09-17T00:00:00.000Z",
          skills: [
            {
              name: "review",
              sourcePath: installed,
              relativePath: ".",
              observedHash: yield* deterministicTreeHash(installed),
            },
          ],
          observations: [],
        }),
      ),
    );
    const history = home.owned(Effect.flatMap(LibraryAuditLog, (audit) => audit.list()));
    const retainedEvents = (yield* history).length;

    const session = yield* home.owned(openLibrarySession());
    const proposed = yield* home.owned(
      proposeLibraryEnable(session, home.bindings, session.skills[0]!, {
        scope: { kind: "global" },
      }),
    );
    const confirmed = yield* home
      .owned(confirmLibraryChange(proposed))
      .pipe(Effect.provideService(LibraryActor, "tui"));
    assert.notStrictEqual(confirmed.outcome?.kind, "failed");

    const events = yield* history;
    assert.strictEqual(events.length, retainedEvents + 1);
    const event = events.at(-1);
    assert.strictEqual(event?.type, "binding.enabled");
    assert.strictEqual(event?.workflow, "tui");
    assert.ok(
      event?.changes.some((change) => change.entity === "binding" && change.action === "enabled"),
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("Collection actions preview and apply all Skills together", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-collection-session-" });
    const home = yield* libraryHome({ home: join(root, "home") });
    yield* initializeLibraryMachine(home.home);
    const source = join(root, "source");
    const skills = yield* Effect.forEach(["alpha", "beta"], (name) =>
      Effect.gen(function* () {
        const path = join(source, name);
        yield* fs.makeDirectory(path, { recursive: true });
        yield* fs.writeFileString(join(path, "SKILL.md"), `# ${name}\n`);
        return {
          name,
          sourcePath: path,
          relativePath: name,
          observedHash: yield* deterministicTreeHash(path),
        };
      }),
    );
    yield* home.owned(
      writingTo(
        home.home,
        retainObservedIn(home.home)({
          source: { type: "local", path: source },
          input: source,
          retainedAt: "2026-10-02T00:00:00.000Z",
          skills,
          observations: [],
        }),
      ),
    );
    const session = yield* home.owned(openLibrarySession());
    const collectionId = (yield* home.durable).collections[0]!.collection_id;
    assert.strictEqual(session.skills.length, 2);
    assert.ok(session.skills.every((row) => row.collectionId === collectionId));
    assert.ok(
      session.skills.every(
        (row) => row.collectionSource?.kind === "local" && row.collectionSource.locator === source,
      ),
    );
    yield* fs.writeFileString(join(source, "alpha", "SKILL.md"), "changed native source\n");
    const alpha = session.skills.find((row) => row.name === "alpha")!;
    assert.strictEqual(
      yield* home.owned(readLibrarySkillContent(alpha.skillVersionId)),
      "# alpha\n",
    );
    const scopes = [{ kind: "global" } as const];
    const proposed = yield* home.owned(
      proposeLibraryCollectionChange(session, home.bindings, collectionId, true, scopes),
    );
    assert.strictEqual(proposed.outcome.kind, "preview");
    assert.deepStrictEqual(proposed.pending?.facts[0]?.skills.slice().sort(), ["alpha", "beta"]);
    assert.ok(
      (yield* home.owned(openLibrarySession())).skills.every((row) => row.scopes.length === 0),
    );
    const enabled = yield* home.owned(confirmLibraryChange(proposed));
    assert.strictEqual(enabled.outcome?.kind, "applied");
    assert.ok(enabled.skills.every((row) => row.scopes.length === 1));
    assert.deepStrictEqual((yield* home.durable).enabled, [{ collection: collectionId }]);
    const unchanged = yield* home.owned(
      proposeLibraryCollectionChange(enabled, home.bindings, collectionId, true, scopes),
    );
    assert.strictEqual(unchanged.outcome.kind, "unchanged");
    assert.strictEqual(unchanged.pending, undefined);
    if (unchanged.outcome.kind === "unchanged")
      assert.strictEqual(unchanged.outcome.pending.facts[0]?.writes, "nothing to change");
    assert.deepStrictEqual(libraryCollectionScopes(enabled, collectionId), scopes);
    const beforeRepair = yield* home.durable;
    const installedSkill = beforeRepair.installed_skills[0]!;
    yield* fs.remove(installedSkill.path, { recursive: true });
    const repair = yield* home.owned(
      proposeLibraryCollectionChange(enabled, home.bindings, collectionId, true, scopes),
    );
    assert.strictEqual(repair.outcome.kind, "preview");
    const repaired = yield* home.owned(confirmLibraryChange(repair));
    assert.strictEqual(repaired.outcome?.kind, "applied");
    assert.ok(yield* fs.exists(installedSkill.path));

    const withLeftover = yield* home.durable;
    const beta = withLeftover.skills.find((skill) => skill.name === "beta")!;
    yield* home.owned(
      writingTo(
        home.home,
        LibraryStore.use((store) =>
          store.save(
            {
              ...withLeftover,
              enabled: [{ skill: beta.skill_id }],
            },
            withLeftover,
          ),
        ),
      ),
    );
    const alphaRow = repaired.skills.find((row) => row.name === "alpha")!;
    const cleanup = yield* home.owned(
      proposeLibraryDisable(
        yield* home.owned(openLibrarySession()),
        home.bindings,
        alphaRow,
        alphaRow.scopes,
      ),
    );
    assert.strictEqual(cleanup.outcome.kind, "preview");
    const cleaned = yield* home.owned(confirmLibraryChange(cleanup));
    assert.strictEqual(cleaned.outcome?.kind, "applied");
    assert.ok(
      !(yield* fs.exists(
        withLeftover.installed_skills.find(
          (copy) =>
            copy.skill_id === withLeftover.skills.find((skill) => skill.name === "alpha")!.skill_id,
        )!.path,
      )),
    );

    const removal = yield* home.owned(
      proposeLibraryCollectionChange(cleaned, home.bindings, collectionId, false, scopes),
    );
    assert.strictEqual(removal.outcome.kind, "preview");
    const disabled = yield* home.owned(confirmLibraryChange(removal));
    assert.strictEqual(disabled.outcome?.kind, "applied");
    assert.ok(disabled.skills.every((row) => row.scopes.length === 0));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

/** One Skill, with a proposal to enable its Collection globally and then in a repository. */
const twoScopeProposal = (scopeCount = 2) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-session-stale-" });
    const home = yield* libraryHome({ home: join(root, "home") });
    yield* initializeLibraryMachine(home.home);
    const source = join(root, "source");
    const repository = join(root, "repository");
    yield* fs.makeDirectory(source, { recursive: true });
    yield* fs.makeDirectory(repository, { recursive: true });
    yield* fs.writeFileString(join(source, "SKILL.md"), "# review\n");
    yield* home.owned(
      writingTo(
        home.home,
        retainObservedIn(home.home)({
          source: { type: "local", path: source },
          input: source,
          retainedAt: "2026-10-13T00:00:00.000Z",
          skills: [
            {
              name: "review",
              sourcePath: source,
              relativePath: ".",
              observedHash: yield* deterministicTreeHash(source),
            },
          ],
          observations: [],
        }),
      ),
    );
    const session = yield* home.owned(openLibrarySession());
    const proposed = yield* home.owned(
      proposeLibraryCollectionChange(
        session,
        home.bindings,
        (yield* home.durable).collections[0]!.collection_id,
        true,
        ([{ kind: "global" }, { kind: "repository", root: repository }] as const).slice(
          0,
          scopeCount,
        ),
      ),
    );
    assert.strictEqual(proposed.pending?.plan.changes.length, scopeCount);
    return { home, proposed };
  });

/** A change from outside the confirming action: it toggles whether ownership issues were recorded. */
const unplanned = (state: LibraryState): LibraryState => {
  if (state.ownershipIssues === undefined) return { ...state, ownershipIssues: [] };
  const { ownershipIssues: _custodyIssues, ...rest } = state;
  return rest;
};

const confirmThrough = (
  home: Effect.Success<ReturnType<typeof twoScopeProposal>>["home"],
  proposed: Parameters<typeof confirmLibraryChange>[0],
  wrap: (store: LibraryStore["Service"]) => LibraryStore["Service"],
) =>
  home.owned(
    Effect.flatMap(LibraryStore, (store) =>
      confirmLibraryChange(proposed).pipe(Effect.provideService(LibraryStore, wrap(store))),
    ),
  );

it.effect("refuses a confirmation when the Library changes after its revision check", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const fixture = yield* twoScopeProposal();
    let loads = 0;
    const confirmed = yield* confirmThrough(fixture.home, fixture.proposed, (store) => ({
      ...store,
      // The first load is the revision check; another writer changes the Library right after it.
      load: Effect.gen(function* () {
        if (++loads === 2) {
          const current = yield* store.load;
          yield* fixture.home
            .writeDurable(unplanned(current))
            .pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.orDie);
        }
        return yield* store.load;
      }),
    }));
    assert.strictEqual(confirmed.outcome?.kind, "failed");
    if (confirmed.outcome?.kind === "failed")
      assert.strictEqual(confirmed.outcome.failure.code, "CONFLICT");
    const state = yield* fixture.home.durable;
    assert.deepStrictEqual(state.enabled, []);
    assert.deepStrictEqual(state.repositories, []);
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("refuses an operation that would apply onto a change made after the previous one", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Count the saves of the first operation alone, on an identical Library.
    const measured = yield* twoScopeProposal(1);
    let firstOperationPublishes = 0;
    yield* confirmThrough(measured.home, measured.proposed, (store) => ({
      ...store,
      save: (next, base) =>
        store.save(next, base).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              firstOperationPublishes++;
            }),
          ),
        ),
    }));

    const fixture = yield* twoScopeProposal();
    let publishes = 0;
    const confirmed = yield* confirmThrough(fixture.home, fixture.proposed, (store) => ({
      ...store,
      save: (next, base) =>
        store
          .save(next, base)
          .pipe(
            Effect.andThen(
              ++publishes === firstOperationPublishes
                ? fixture.home
                    .writeDurable(unplanned(next))
                    .pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.orDie)
                : Effect.void,
            ),
          ),
    }));
    assert.strictEqual(confirmed.outcome?.kind, "failed");
    if (confirmed.outcome?.kind === "failed")
      assert.strictEqual(confirmed.outcome.failure.code, "CONFLICT");
    const state = yield* fixture.home.durable;
    assert.strictEqual(state.enabled.length, 1);
    assert.deepStrictEqual(state.repositories, []);
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
