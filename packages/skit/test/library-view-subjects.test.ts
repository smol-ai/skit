import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { skitLayer } from "../src/platform/layer.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { libraryView } from "../src/library/internal/session/library-view.js";

import { matchingLibrarySubjects } from "../src/library/subject-resolution.js";
import { makeCollectionId, makeSkillId } from "../src/library/entity-ids.js";
import { testRoots } from "./helpers/library-store.js";
import { emptyLibraryState, type LibraryState } from "../src/library/library-state.js";

it.effect(
  "an unavailable Author Workspace source stays absent data rather than a display label",
  () =>
    Effect.gen(function* () {
      const collectionId = makeCollectionId();
      const state: LibraryState = {
        ...emptyLibraryState(),
        collections: [
          {
            collection_id: collectionId,
            label: "review",
            upstream: {
              source_identity: { kind: "authored-workspace", workspace_id: "workspace" },
              tracking: { kind: "default" },
            },
          },
        ],
        skills: [
          {
            skill_id: makeSkillId(),
            collection_id: collectionId,
            name: "review",
            path: ".",
            versions: [],
          },
        ],
      };
      const subjects = yield* libraryView(state, "/unused").readSubjects();
      assert.strictEqual(subjects[0]?.skills[0]?.source, null);
      assert.deepInclude(subjects[0]?.collectionSource, {
        kind: "authored-workspace",
        locator: "",
        workspace_status: "unavailable",
      });
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "subject selection preserves skill/collection precedence and rejects ambiguity before fetching",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-view-subjects-" });
      const source = join(root, "review");
      const home = join(root, "library");
      for (const name of ["review", "test"]) {
        yield* fs.makeDirectory(join(source, name), { recursive: true });
        yield* fs.writeFileString(
          join(source, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Test Skill.\n---\n# ${name}\n`,
        );
      }
      const request = yield* localImportRequest(source, "2026-11-06T00:00:00.000Z");
      if (Option.isNone(request)) return yield* Effect.die("Expected plain collection");
      const snapshot = yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        yield* library.import.collection(request.value);
        return yield* library.read;
      }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
      if (snapshot._tag !== "Present") return yield* Effect.die("Expected imported Library");
      const state = snapshot.state;
      const member = state.skills.find((skill) => skill.name === "review");
      assert.ok(member);
      assert.deepStrictEqual(
        matchingLibrarySubjects(state, member.skill_id).map((subject) => subject.kind),
        ["skill"],
      );
      assert.strictEqual(
        (yield* libraryView(state, "unused").removalSummary(member.skill_id).pipe(Effect.flip))
          ._tag,
        "Library.SkillRemovalRequiresCollection",
      );
      const firstCollection = state.collections[0];
      assert.ok(firstCollection);
      const sameNamed = {
        ...state,
        collections: state.collections.map((candidate) => ({ ...candidate, label: "review" })),
      };
      assert.deepStrictEqual(
        matchingLibrarySubjects(sameNamed, "review").map((subject) => subject.kind),
        ["collection"],
      );
      assert.strictEqual(
        (yield* libraryView(sameNamed, "unused").removalSummary("review")).subject_kind,
        "collection",
      );
      const secondCollectionId = makeCollectionId();
      const ambiguous = {
        ...sameNamed,
        collections: [
          ...sameNamed.collections,
          { ...firstCollection, label: "review", collection_id: secondCollectionId },
        ],
        skills: [
          ...sameNamed.skills,
          { ...member, skill_id: makeSkillId(), collection_id: secondCollectionId },
        ],
      };
      assert.strictEqual(matchingLibrarySubjects(ambiguous, "review").length, 2);
      assert.strictEqual(
        (yield* libraryView(ambiguous, "unused").removalSummary("review").pipe(Effect.flip))._tag,
        "Library.SubjectAmbiguous",
      );
      assert.strictEqual(
        (yield* libraryView(ambiguous, "unused")
          .previewSourceUpdates("review", () =>
            Effect.die("ambiguous query must not fetch a Source"),
          )
          .pipe(Effect.flip))._tag,
        "Library.SubjectAmbiguous",
      );
      assert.strictEqual(
        (yield* libraryView(ambiguous, "unused")
          .checkSubjects("review", {
            inspectSource: () => Effect.die("ambiguous query must not fetch a Source"),
          })
          .pipe(Effect.flip))._tag,
        "Library.SubjectAmbiguous",
      );
      const secondSource = join(root, "other", "review");
      yield* fs.makeDirectory(secondSource, { recursive: true });
      yield* fs.writeFileString(
        join(secondSource, "SKILL.md"),
        "---\nname: review\ndescription: Other review.\n---\n# Review\n",
      );
      const secondRequest = yield* localImportRequest(secondSource, "2026-11-06T00:00:00.000Z");
      if (Option.isNone(secondRequest)) return yield* Effect.die("Expected second collection");
      yield* Effect.flatMap(Library.Service, (library) =>
        library.import.collection(secondRequest.value),
      ).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
      const configuration = {
        home: root,
        configHome: join(root, "config"),
        overrides: { codex: [join(root, "enabled")] },
      };
      const library = yield* Library.Service.pipe(
        Effect.provide(Library.layer({ home, roots: configuration })),
      );
      const failure = yield* library
        .planEnabled([{ subject: "review", enabled: true, where: [{ kind: "global" }] }], {
          base: yield* library.read,
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "Library.SubjectAmbiguous");
      assert.isFalse(yield* fs.exists(join(root, "enabled")));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a captured view keeps Skill records private and survives mutations to input and returned values",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-view-records-" });
      const source = join(root, "source");
      const home = join(root, "library");
      for (const name of ["review", "test"]) {
        yield* fs.makeDirectory(join(source, name), { recursive: true });
        yield* fs.writeFileString(
          join(source, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Test Skill.\n---\n# ${name}\n`,
        );
      }
      const request = yield* localImportRequest(source, "2026-11-06T00:00:00.000Z");
      if (Option.isNone(request)) return assert.fail("Expected a Collection");
      const snapshot = yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        yield* library.import.collection(request.value);
        return yield* library.read;
      }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
      if (snapshot._tag !== "Present") return assert.fail("Expected an imported Library");
      const view = libraryView(snapshot.state, join(home, "originals"));
      const rows = yield* view.readSkills();
      const subjects = yield* view.readSubjects();
      const expected = rows.map(({ authorInvocation, ...value }) => ({
        ...structuredClone(value),
        authorInvocation,
      }));
      assert.deepStrictEqual(rows.map((row) => row.name).sort(), ["review", "test"]);
      for (const row of [
        ...rows,
        ...view.collections.flatMap((collection) => collection.members),
        ...subjects.flatMap((subject) => subject.skills),
      ]) {
        assert.isFalse(Object.hasOwn(row, "record"));
        assert.isFalse(Object.hasOwn(row, "value"));
        assert.isFalse(Object.hasOwn(row, "skill_id"));
      }
      const [first] = rows;
      const [collection] = view.collections;
      const [original] = snapshot.state.skills;
      assert.ok(first);
      assert.ok(collection?.members[0]);
      assert.ok(original);
      Reflect.set(first, "name", "Changed by a reader");
      Reflect.set(collection.members[0], "name", "Changed in the Collection summary");
      Reflect.set(original, "name", "Changed after opening the view");
      snapshot.state.skills.reverse();
      assert.deepStrictEqual(yield* view.readSkills(), expected);
      assert.deepStrictEqual(yield* view.readSubjects(), subjects);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
