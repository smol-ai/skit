import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  currentSkillVersion,
  LibraryStore,
  libraryManifestFromLocalStateEffect,
  deterministicTreeHashEffect,
  libraryStoreLayer,
  retainedTreePath,
  skitLayer,
} from "@smolai/skit-core";
import {
  addLibrarySourceEffect,
  previewLibrarySourceEffect,
} from "../src/workflows/library/add.js";
import { planUpdatesEffect, updateSubjectsEffect } from "../src/workflows/library/update.js";
import { checkSubjectsEffect } from "../src/workflows/library/check.js";
import { applyLibraryBindings } from "../src/workflows/library/set-enabled.js";
import { planLibrarySync } from "../src/workflows/library/library-sync-plan.js";
import { executeRemoveEffect } from "../src/workflows/library/remove.js";
import { librarySubjects } from "../src/workflows/library/subject-resolution.js";
import { initializeLibraryMachine, retainObservedIn, writingTo } from "./helpers/library-home.js";
import { rendererTestLayer } from "./helpers/renderer.js";

it.effect("previews without mutation, then retains exact root Skill bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-add-" });
    const source = join(root, "source");
    const home = join(root, "home");
    yield* fs.makeDirectory(source);
    yield* initializeLibraryMachine(home);
    const bytes = "---\nname: review\ndescription: Review carefully\n---\n\nDo the review.\n";
    yield* fs.writeFileString(join(source, "SKILL.md"), bytes);
    assert.deepStrictEqual(yield* previewLibrarySourceEffect(source), {
      kind: "plain",
      skills: [{ name: "review", verbatim_path: "." }],
    });
    assert.strictEqual(yield* fs.exists(join(home, "state.json")), false);

    const added = yield* addLibrarySourceEffect(source).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    const state = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    assert.strictEqual(state.collections.length, 1);
    assert.strictEqual(state.skills[0]?.name, "review");
    assert.strictEqual(state.retained_copies[0]?.retained_copy_id, added.retained_version_id);
    assert.strictEqual(
      yield* fs.readFileString(
        join(retainedTreePath(join(home, "originals"), added.snapshot_digest), "SKILL.md"),
      ),
      bytes,
    );
    assert.strictEqual(state.collections[0]?.upstream, undefined);

    yield* fs.writeFileString(join(source, "SKILL.md"), `${bytes}\nSecond snapshot.\n`);
    const addedAgain = yield* addLibrarySourceEffect(source).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    const refreshed = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    assert.strictEqual(addedAgain.collection_id, added.collection_id);
    assert.strictEqual(refreshed.collections.length, 1);
    // The superseded snapshot backs nothing still in use, so it is pruned.
    assert.strictEqual(refreshed.acquisitions.length, 1);
    assert.strictEqual(refreshed.skills[0]?.versions.length, 1);
    const failure = yield* planUpdatesEffect(
      refreshed,
      {
        roots: { home: root, configHome: join(root, "config"), overrides: {} },
        variantsPath: join(home, "variants"),
      },
      added.collection_id,
    ).pipe(Effect.provide(libraryStoreLayer({ home })), Effect.flip);
    if (failure._tag !== "Library.UpdateNotRefreshable")
      return assert.fail(`Expected UpdateNotRefreshable, received ${failure._tag}`);
    assert.strictEqual(failure.subject_id, added.collection_id);
    assert.strictEqual(failure.source, source);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("retains nested Skills as one Collection with independent Skill identities", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-add-nested-" });
    const source = join(root, "source");
    const home = join(root, "home");
    yield* initializeLibraryMachine(home);
    for (const name of ["review", "plan"]) {
      const path = join(source, "skills", name);
      yield* fs.makeDirectory(path, { recursive: true });
      yield* fs.writeFileString(
        join(path, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\n`,
      );
    }
    const added = yield* addLibrarySourceEffect(source).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    const state = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    assert.deepStrictEqual(added.skills.map((skill) => skill.verbatim_path).sort(), [
      "skills/plan",
      "skills/review",
    ]);
    assert.strictEqual(
      state.skills.filter((skill) => skill.collection_id === state.collections[0]?.collection_id)
        .length,
      2,
    );
    assert.deepStrictEqual(state.skills.map((skill) => skill.name).sort(), ["plan", "review"]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("runs the complete lifecycle for a selected well-known Collection member", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-standalone-update-" });
    const home = join(root, "home");
    yield* initializeLibraryMachine(home);
    const base = "https://skills.example.test";
    const original = "---\nname: review\ndescription: Review.\n---\n\n# Original\n";
    const updated = "---\nname: review\ndescription: Review.\n---\n\n# Updated\n";
    let artifact = original;
    const client = HttpClient.make((request) => {
      const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
      const index = JSON.stringify({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "review",
            description: "Review.",
            type: "skill-md",
            url: "/review/SKILL.md",
            digest,
          },
        ],
      });
      const body = request.url.endsWith("/.well-known/agent-skills/index.json")
        ? index
        : request.url.endsWith("/review/SKILL.md")
          ? artifact
          : "missing";
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, { status: body === "missing" ? 404 : 200 }),
        ),
      );
    });
    const source = { type: "well-known" as const, origin: base, skillNames: ["review"] };
    const options = {
      roots: {
        home: root,
        configHome: join(root, "config"),
        overrides: { codex: join(root, "codex") },
      },
      variantsPath: join(home, "variants"),
    };
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(libraryStoreLayer({ home })),
        Effect.provideService(HttpClient.HttpClient, client),
      );
    const added = yield* run(addLibrarySourceEffect(source));
    const before = yield* run(Effect.flatMap(LibraryStore, (store) => store.load));
    assert.strictEqual(before.collections.length, 1);
    const skill = before.skills[0]!;
    assert.strictEqual(skill.collection_id, before.collections[0]?.collection_id);
    assert.deepStrictEqual(
      librarySubjects(before).map((subject) => [subject.kind, subject.subjectId, subject.label]),
      [["collection", before.collections[0]?.collection_id, base]],
    );
    const bindingInput = (enabled: boolean) => ({
      query: skill.skill_id,
      all: false,
      roots: options.roots,
      variantsPath: options.variantsPath,
      invocation: {
        subjects: [skill.skill_id],
        harnesses: ["codex" as const],
        scope: { kind: "global" as const },
        enabled,
        dryRun: false,
      },
    });
    yield* writingTo(home, run(applyLibraryBindings(before, bindingInput(true))));
    const enabled = yield* run(Effect.flatMap(LibraryStore, (store) => store.load));
    assert.deepStrictEqual(enabled.global_bindings[0]?.entries, [
      { kind: "skill", skill_id: skill.skill_id },
    ]);
    assert.strictEqual(yield* fs.exists(join(root, "codex", "review", "SKILL.md")), true);
    assert.strictEqual(
      (yield* run(checkSubjectsEffect(enabled, skill.skill_id)))[0]?.source_status,
      "current",
    );
    artifact = updated;
    assert.strictEqual(
      (yield* run(planUpdatesEffect(enabled, options, skill.skill_id)))[0]?.changed,
      true,
    );
    const result = yield* run(
      updateSubjectsEffect(enabled, options, skill.skill_id).pipe(
        Effect.provide(rendererTestLayer()),
      ),
    );
    assert.strictEqual(result[0]?.changed, true);
    const after = yield* run(Effect.flatMap(LibraryStore, (store) => store.load));
    assert.strictEqual(after.collections.length, 1);
    assert.strictEqual(after.skills[0]?.skill_id, added.skill_ids[0]);
    // The Projection moved to the new Version, so the superseded one is pruned.
    assert.strictEqual(after.skills[0]?.versions.length, 1);
    const desired = yield* libraryManifestFromLocalStateEffect(after);
    const empty = {
      ...desired,
      collections: [],
      skills: [],
      retained_copies: [],
      acquisitions: [],
      snapshot_digests: [],
      bindings: [],
    };
    assert.deepStrictEqual(planLibrarySync(desired, empty, desired).remote[0]?.kind, "collection");
    yield* writingTo(home, run(applyLibraryBindings(after, bindingInput(false))));
    const disabled = yield* run(Effect.flatMap(LibraryStore, (store) => store.load));
    assert.deepStrictEqual(disabled.global_bindings, []);
    yield* writingTo(
      home,
      run(
        // The Collection's only Skill can be removed, taking its Collection with it.
        executeRemoveEffect(disabled, {
          query: skill.skill_id,
          dryRun: false,
          variantsPath: options.variantsPath,
        }),
      ),
    );
    const removed = yield* run(Effect.flatMap(LibraryStore, (store) => store.load));
    assert.deepStrictEqual(removed.skills, []);
    assert.deepStrictEqual(removed.collections, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("re-adding a changed local source replaces its unused Skill Version", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-update-" });
    const source = join(root, "source");
    const home = join(root, "home");
    yield* fs.makeDirectory(source);
    yield* initializeLibraryMachine(home);
    yield* fs.writeFileString(
      join(source, "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\nfirst\n",
    );
    const added = yield* addLibrarySourceEffect(source).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    yield* fs.writeFileString(
      join(source, "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\nsecond\n",
    );
    const addedAgain = yield* writingTo(home, addLibrarySourceEffect(source));
    const after = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    // Nothing installs the first Version, so only the current one is kept.
    assert.strictEqual(after.skills[0]?.versions.length, 1);
    assert.strictEqual(
      currentSkillVersion(after, after.skills[0]!)?.skill_version_id,
      after.skills[0]?.versions[0]?.skill_version_id,
    );
    assert.strictEqual(after.retained_copies.length, 1);
    assert.strictEqual(addedAgain.collection_id, added.collection_id);
    // The write transaction deletes the retained tree nothing references any more.
    const originals = join(home, "originals");
    assert.strictEqual(yield* fs.exists(retainedTreePath(originals, added.snapshot_digest)), false);
    assert.strictEqual(
      yield* fs.exists(retainedTreePath(originals, addedAgain.snapshot_digest)),
      true,
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("repeated identical local re-adds record nothing new", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-portable-current-" });
    const source = join(root, "source");
    const home = join(root, "home");
    yield* fs.makeDirectory(source);
    yield* initializeLibraryMachine(home);
    yield* fs.writeFileString(
      join(source, "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\ncurrent\n",
    );
    const added = yield* addLibrarySourceEffect(source).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );
    yield* fs.writeFileString(
      join(source, ".skit-ownership.json"),
      '{"schemaVersion":1,"projectionId":"projection-test"}\n',
    );
    const reAdd = addLibrarySourceEffect(source).pipe(Effect.provide(libraryStoreLayer({ home })));
    const load = Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );

    const first = yield* reAdd;
    const second = yield* reAdd;
    const after = yield* load;

    assert.strictEqual(first.snapshot_digest, added.snapshot_digest);
    assert.strictEqual(second.snapshot_digest, added.snapshot_digest);
    assert.strictEqual(after.retained_copies.length, 1);
    assert.strictEqual(after.acquisitions.length, 1);
    assert.strictEqual(after.skills[0]?.versions.length, 1);
    assert.strictEqual(
      yield* fs.exists(
        join(
          retainedTreePath(join(home, "originals"), added.snapshot_digest),
          ".skit-ownership.json",
        ),
      ),
      false,
    );
    assert.ok(
      after.acquisitions.every(
        (acquisition) => acquisition.retained_copy_id === added.retained_version_id,
      ),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("records a new upstream commit even when its Skill bytes are unchanged", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-same-bytes-" });
    const checkout = join(root, "checkout");
    const skill = join(checkout, "review");
    const home = join(root, "home");
    yield* initializeLibraryMachine(home);
    yield* fs.makeDirectory(skill, { recursive: true });
    yield* fs.writeFileString(
      join(skill, "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\nunchanged\n",
    );
    const observedHash = yield* deterministicTreeHashEffect(skill);
    const retainAt = (sourceRevision: string, retainedAt: string) =>
      Effect.scoped(
        writingTo(
          home,
          retainObservedIn(home)({
            source: { type: "github", owner: "acme", repository: "skills" },
            input: "https://github.com/acme/skills.git",
            sourceRevision,
            retainedAt,
            skills: [{ name: "review", sourcePath: skill, relativePath: "review", observedHash }],
            observations: [],
          }),
        ),
      );
    const load = Effect.flatMap(LibraryStore, (store) => store.load).pipe(
      Effect.provide(libraryStoreLayer({ home })),
    );

    yield* retainAt("a".repeat(40), "2026-09-16T01:00:00.000Z");
    yield* retainAt("b".repeat(40), "2026-09-16T02:00:00.000Z");
    const recorded = yield* load;
    yield* retainAt("b".repeat(40), "2026-09-16T03:00:00.000Z");
    const repeated = yield* load;

    // The new commit is recorded; the superseded Acquisition backs nothing and is pruned.
    assert.strictEqual(recorded.retained_copies.length, 1);
    assert.deepStrictEqual(
      recorded.acquisitions.map((acquisition) => acquisition.revision),
      ["b".repeat(40)],
    );
    assert.deepStrictEqual(repeated.acquisitions, recorded.acquisitions);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
