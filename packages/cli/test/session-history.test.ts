import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import {
  deterministicTreeHashEffect,
  LibraryActor,
  LibraryStore,
  LibraryAuditLog,
  skitLayer,
} from "@smolai/skit-core";
import {
  confirmLibraryChange,
  openLibrarySession,
  readLibrarySkillContent,
  proposeLibraryEnable,
  proposeLibraryDisable,
  proposeLibraryCollectionChange,
  libraryCollectionScopes,
} from "../src/workflows/library/session.js";
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
              observedHash: yield* deterministicTreeHashEffect(installed),
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
      .owned(confirmLibraryChange(proposed, home.bindings))
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
          observedHash: yield* deterministicTreeHashEffect(path),
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
      (yield* home.owned(openLibrarySession())).skills.every((row) => row.bindings.length === 0),
    );
    const enabled = yield* home.owned(confirmLibraryChange(proposed, home.bindings));
    assert.strictEqual(enabled.outcome?.kind, "applied");
    assert.ok(enabled.skills.every((row) => row.bindings.length === 1));
    assert.deepStrictEqual((yield* home.durable).global_bindings[0]?.entries, [
      { kind: "collection", collection_id: collectionId },
    ]);
    const unchanged = yield* home.owned(
      proposeLibraryCollectionChange(enabled, home.bindings, collectionId, true, scopes),
    );
    assert.strictEqual(unchanged.outcome.kind, "unchanged");
    assert.strictEqual(unchanged.pending, undefined);
    if (unchanged.outcome.kind === "unchanged")
      assert.strictEqual(unchanged.outcome.pending.facts[0]?.writes, "nothing to change");
    assert.deepStrictEqual(libraryCollectionScopes(enabled, collectionId), scopes);
    const beforeRepair = yield* home.durable;
    const projection = beforeRepair.projections[0]!;
    yield* fs.remove(projection.path, { recursive: true });
    const repair = yield* home.owned(
      proposeLibraryCollectionChange(enabled, home.bindings, collectionId, true, scopes),
    );
    assert.strictEqual(repair.outcome.kind, "preview");
    const repaired = yield* home.owned(confirmLibraryChange(repair, home.bindings));
    assert.strictEqual(repaired.outcome?.kind, "applied");
    assert.ok(yield* fs.exists(projection.path));

    const withLeftover = yield* home.durable;
    const beta = withLeftover.skills.find((skill) => skill.name === "beta")!;
    yield* home.owned(
      writingTo(
        home.home,
        LibraryStore.use((store) =>
          store.publish({
            ...withLeftover,
            global_bindings: [
              { scope: { kind: "global" }, entries: [{ kind: "skill", skill_id: beta.skill_id }] },
            ],
          }),
        ),
      ),
    );
    const alphaRow = repaired.skills.find((row) => row.name === "alpha")!;
    const cleanup = yield* home.owned(
      proposeLibraryDisable(repaired, home.bindings, alphaRow, alphaRow.bindings),
    );
    assert.strictEqual(cleanup.outcome.kind, "preview");
    const cleaned = yield* home.owned(confirmLibraryChange(cleanup, home.bindings));
    assert.strictEqual(cleaned.outcome?.kind, "applied");
    assert.ok(
      !(yield* fs.exists(
        withLeftover.projections.find(
          (copy) =>
            copy.skill_id === withLeftover.skills.find((skill) => skill.name === "alpha")!.skill_id,
        )!.path,
      )),
    );

    const removal = yield* home.owned(
      proposeLibraryCollectionChange(enabled, home.bindings, collectionId, false, scopes),
    );
    assert.strictEqual(removal.outcome.kind, "preview");
    const disabled = yield* home.owned(confirmLibraryChange(removal, home.bindings));
    assert.strictEqual(disabled.outcome?.kind, "applied");
    assert.ok(disabled.skills.every((row) => row.bindings.length === 0));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
