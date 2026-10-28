import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import {
  deterministicTreeHash,
  LibraryStore,
  libraryStoreLayer,
  makeCollectionId,
  makeSkillId,
  type ImportRequestSkill,
} from "@smolai/skit-core";
import { isolatedRoots } from "./helpers/isolated-library.js";
import { setLibraryEnabled, planLibraryEnabled } from "./helpers/set-enabled.js";
import { calculateSetEnabled } from "../src/workflows/library/set-enabled-request.js";
import { applySetEnabledPlan } from "../src/library-application/set-enabled.js";
import { planRemove } from "../src/workflows/library/remove.js";
import { planUpdates } from "../src/library-application/update.js";
import { checkSubjects } from "../src/workflows/library/check.js";
import { matchingLibrarySubjects } from "../src/workflows/library/subject-resolution.js";
import { initializeLibraryMachine, importCollectionIn, writingTo } from "./helpers/library-home.js";

it.effect("partially binds raw Skills and converges after enable and disable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-portable-enable-" });
    const roots = isolatedRoots(workspace);
    const home = roots.home;
    const observed = join(workspace, "observed");
    yield* initializeLibraryMachine(home);
    const review = join(observed, "review");
    const test = join(observed, "test");
    for (const path of [review, test]) yield* fs.makeDirectory(path, { recursive: true });
    yield* fs.writeFileString(join(review, "SKILL.md"), "review raw bytes\n");
    yield* fs.writeFileString(join(test, "SKILL.md"), "test raw bytes\n");
    const collection = yield* Effect.scoped(
      writingTo(
        home,
        importCollectionIn(home)({
          source: { type: "local", path: observed },
          input: observed,
          importedAt: "2026-09-16T00:00:00.000Z",
          skills: [
            {
              name: "review",
              sourcePath: review,
              relativePath: "review",
              currentHash: yield* deterministicTreeHash(review),
            },
            {
              name: "test",
              sourcePath: test,
              relativePath: "test",
              currentHash: yield* deterministicTreeHash(test),
            },
          ],
          lockFileEntries: [],
        }),
      ),
    );
    const layer = libraryStoreLayer({ home });
    const state = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.ok(state);
    const base = {
      libraryHome: home,
      query: collection.collection?.collection_id ?? "",
      all: false,
      selectedSkills: ["review"],
      roots: {
        home: workspace,
        configHome: join(workspace, "config"),
        overrides: {
          codex: [roots.codexRoot],
          "claude-code": [roots.claudeRoot],
          opencode: [roots.opencodeRoot],
          devin: roots.devinRoots,
        },
      },
      variantsPath: join(home, "variants"),
      now: () => "2026-09-16T00:00:00.000Z",
    };
    const invocation = {
      harnesses: ["codex" as const],
      scope: { kind: "global" as const },
      enabled: true,
      dryRun: true,
    };
    const member = state.skills.find((skill) => skill.name === "review");
    assert.ok(member);
    assert.deepStrictEqual(
      matchingLibrarySubjects(state, member.skill_id).map((subject) => subject.kind),
      ["skill"],
    );
    assert.strictEqual(
      (yield* planRemove(state, member.skill_id).pipe(Effect.flip))._tag,
      "Library.SkillRemovalRequiresCollection",
    );
    const sameNamed = {
      ...state,
      collections: state.collections.map((candidate) => ({ ...candidate, label: "review" })),
    };
    assert.deepStrictEqual(
      matchingLibrarySubjects(sameNamed, "review").map((subject) => subject.kind),
      ["collection"],
    );
    assert.strictEqual((yield* planRemove(sameNamed, "review")).subject_kind, "collection");
    const secondCollectionId = makeCollectionId();
    const ambiguous = {
      ...sameNamed,
      collections: [
        ...sameNamed.collections,
        { ...sameNamed.collections[0]!, collection_id: secondCollectionId },
      ],
      skills: [
        ...sameNamed.skills,
        { ...member, skill_id: makeSkillId(), collection_id: secondCollectionId },
      ],
    };
    assert.strictEqual(matchingLibrarySubjects(ambiguous, "review").length, 2);
    const previewStore = yield* LibraryStore.pipe(Effect.provide(layer));
    assert.strictEqual(
      (yield* planRemove(ambiguous, "review").pipe(Effect.flip))._tag,
      "Library.SubjectAmbiguous",
    );
    assert.strictEqual(
      (yield* planUpdates("review").pipe(
        Effect.provideService(LibraryStore, { ...previewStore, load: Effect.succeed(ambiguous) }),
        Effect.flip,
      ))._tag,
      "Library.SubjectAmbiguous",
    );
    assert.strictEqual(
      (yield* checkSubjects(ambiguous, "review").pipe(Effect.provide(layer), Effect.flip))._tag,
      "Library.SubjectAmbiguous",
    );
    assert.strictEqual(
      (yield* calculateSetEnabled(ambiguous, {
        ...base,
        query: "review",
        scope: invocation.scope,
        enabled: invocation.enabled,
      }).pipe(Effect.flip))._tag,
      "Library.SubjectAmbiguous",
    );
    const planned = yield* setLibraryEnabled({
      ...base,
      invocation,
    }).pipe(Effect.provide(layer));
    assert.strictEqual(planned.kind, "plan");
    assert.deepEqual(planned.value.skills, ["review"]);
    assert.strictEqual(yield* fs.exists(join(roots.codexRoot, "review")), false);
    const beforeApply = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.deepEqual(beforeApply?.enabled, []);

    const previewed = yield* planLibraryEnabled({ ...base, invocation }).pipe(
      Effect.provide(layer),
    );
    yield* writingTo(
      home,
      LibraryStore.use((store) =>
        store.save({ ...state, ownershipIssues: state.ownershipIssues ?? [] }, state),
      ).pipe(Effect.provide(layer)),
    );
    const stale = yield* applySetEnabledPlan(previewed).pipe(Effect.provide(layer), Effect.flip);
    assert.strictEqual(stale._tag, "Library.SetEnabledStale");
    yield* writingTo(
      home,
      LibraryStore.use((store) =>
        Effect.flatMap(store.load, (current) => store.save(state, current)),
      ).pipe(Effect.provide(layer)),
    );

    const apply = (enabled: boolean) =>
      Effect.gen(function* () {
        const current = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
        assert.ok(current);
        return yield* setLibraryEnabled({
          ...base,
          invocation: { ...invocation, enabled, dryRun: false },
        }).pipe(Effect.provide(layer));
      });
    const enabled = yield* writingTo(home, apply(true));
    assert.strictEqual(enabled.kind, "applied");
    assert.strictEqual(enabled.value.changed, true);
    assert.strictEqual(
      yield* fs.readFileString(join(roots.codexRoot, "review", "SKILL.md")),
      "review raw bytes\n",
    );
    assert.strictEqual(yield* fs.exists(join(roots.codexRoot, "test")), false);
    const imported = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    const reviewSkillId = imported?.skills.find((skill) => skill.name === "review")?.skill_id;
    assert.ok(reviewSkillId);
    assert.deepEqual(imported?.enabled, [{ skill: reviewSkillId }]);
    const repeated = yield* writingTo(home, apply(true));
    assert.strictEqual(repeated.value.changed, false);
    assert.strictEqual(repeated.value.repair, undefined);
    yield* fs.remove(join(roots.codexRoot, "review"), { recursive: true });
    const repaired = yield* writingTo(home, apply(true));
    assert.strictEqual(repaired.value.changed, false);
    assert.strictEqual(repaired.value.repair, true);
    assert.strictEqual(
      yield* fs.readFileString(join(roots.codexRoot, "review", "SKILL.md")),
      "review raw bytes\n",
    );
    const disabled = yield* writingTo(home, apply(false));
    assert.strictEqual(disabled.value.changed, true);
    assert.strictEqual(yield* fs.exists(join(roots.codexRoot, "review")), false);
    const final = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
    assert.deepEqual(final?.enabled, []);
    assert.strictEqual(final?.skills.find((skill) => skill.name === "review")?.versions.length, 1);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("enables a whole Collection and converts it to Skills when one is disabled", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-collection-entry-" });
    const roots = isolatedRoots(workspace);
    const home = roots.home;
    const observed = join(workspace, "observed");
    yield* initializeLibraryMachine(home);
    const skills: ImportRequestSkill[] = [];
    for (const name of ["review", "test", "docs"]) {
      const path = join(observed, name);
      yield* fs.makeDirectory(path, { recursive: true });
      yield* fs.writeFileString(join(path, "SKILL.md"), `${name} raw bytes\n`);
      skills.push({
        name,
        sourcePath: path,
        relativePath: name,
        currentHash: yield* deterministicTreeHash(path),
      });
    }
    const importSource = (members: readonly ImportRequestSkill[], importedAt: string) =>
      Effect.scoped(
        writingTo(
          home,
          importCollectionIn(home)({
            source: { type: "local", path: observed },
            input: observed,
            importedAt,
            skills: members,
            lockFileEntries: [],
          }),
        ),
      );
    const imported = yield* importSource(skills, "2026-09-16T00:00:00.000Z");
    const collectionId = imported.collection!.collection_id;
    const skillId = (name: string) =>
      imported.skills.find((skill) => skill.name === name)!.skill_id;
    const layer = libraryStoreLayer({ home });
    const set = (query: string, enabled: boolean, all: boolean) =>
      Effect.gen(function* () {
        yield* writingTo(
          home,
          setLibraryEnabled({
            query,
            all,
            roots: {
              home: workspace,
              configHome: join(workspace, "config"),
              overrides: { codex: [roots.codexRoot] },
            },
            variantsPath: join(home, "variants"),
            invocation: {
              scope: { kind: "global" as const },
              enabled,
              dryRun: false,
            },
          }).pipe(Effect.provide(layer)),
        );
        const settled = yield* LibraryStore.use((store) => store.load).pipe(Effect.provide(layer));
        return settled.enabled ?? [];
      });

    assert.deepStrictEqual(yield* set(skillId("review"), true, false), [
      { skill: skillId("review") },
    ]);
    // `--all` follows the Collection and replaces its individual entries.
    assert.deepStrictEqual(yield* set(collectionId, true, true), [{ collection: collectionId }]);
    // Disabling one Skill keeps the Collection's other current Skills individually.
    assert.deepStrictEqual(yield* set(skillId("test"), false, false), [
      { skill: skillId("review") },
      { skill: skillId("docs") },
    ]);
    assert.deepStrictEqual((yield* fs.readDirectory(roots.codexRoot)).sort(), ["docs", "review"]);
    // Disabling the whole Collection removes every entry for it.
    assert.deepStrictEqual(yield* set(collectionId, false, true), []);
    // A Skill gone from the Source stays while its own entry enables it, and `--all` ends that too.
    yield* set(skillId("review"), true, false);
    yield* importSource(
      skills.filter((skill) => skill.name !== "review"),
      "2026-09-16T01:00:00.000Z",
    );
    assert.deepStrictEqual(yield* set(collectionId, false, true), []);
    assert.deepStrictEqual(yield* fs.readDirectory(roots.codexRoot), []);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
