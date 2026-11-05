import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { skitLayer } from "../src/platform/layer.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { libraryView } from "../src/library/internal/session/library-view.js";
import { openSetEnabledSession } from "../src/library/session.js";
import { matchingLibrarySubjects } from "../src/library/subject-resolution.js";
import { makeCollectionId, makeSkillId } from "../src/library/entity-ids.js";

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
      }).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));
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
      ).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));
      const configuration = {
        home: root,
        configHome: join(root, "config"),
        overrides: { codex: [join(root, "enabled")] },
      };
      const selection = yield* openSetEnabledSession(home, configuration);
      const failure = yield* selection
        .plan({ subject: "review", enabled: true, where: [{ kind: "global" }] }, configuration)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "Library.SubjectAmbiguous");
      assert.isFalse(yield* fs.exists(join(root, "enabled")));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
