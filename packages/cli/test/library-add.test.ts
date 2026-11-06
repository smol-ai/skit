import { originalTreePath } from "./helpers/original-tree.js";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import {
  currentSkillVersion,
  emptyLibraryState,
  libraryManifestFromLocalState,
} from "@smolai/skit-core";
import { deterministicTreeHash } from "@smolai/skit-core/author";
import { Library } from "@smolai/skit-core/library";
import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { HttpClient, HttpClientResponse } from "effect/http";

import { importSource, previewLibrarySource } from "../src/library/source.js";
import { planUpdates, updateSubjects } from "../src/library/update/operation.js";
import { checkSubjects } from "../src/library/check/operation.js";
import { setLibraryEnabled } from "./helpers/set-enabled.js";
import { openLibraryView, openSyncSession } from "@smolai/skit-core/library/session";
import { executeRemove } from "../src/library/remove/operation.js";

import {
  archiveBytes,
  boundSkit,
  initializeLibraryMachine,
  importCollectionIn,
  writingTo,
} from "./helpers/library-home.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import { homeLockIsFree } from "./helpers/home-lock.js";

/** The Library at `home`, read through its owner. */
const stateAt = (home: string) =>
  Effect.flatMap(Library.Service, (library) => library.read).pipe(
    Effect.map((snapshot) => (snapshot._tag === "Present" ? snapshot.state : emptyLibraryState())),
    Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
  );

it.effect(
  "source acquisition stays outside the writer and the owner publishes one locked action",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-add-lock-scope-" });
      const home = join(root, "library");
      const source = join(root, "source");
      const skillPath = join(source, "SKILL.md");
      const bytes =
        "---\nname: review\ndescription: Lock scope fixture\n---\nExact source bytes.\n";
      yield* fs.makeDirectory(home);
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(skillPath, bytes);
      let sourceReadWithoutWriter: boolean | undefined;
      let stateSavedWithWriter = false;
      const checkSourceRead = <A, E, R>(path: string, read: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          if (path === skillPath && sourceReadWithoutWriter === undefined)
            sourceReadWithoutWriter = yield* homeLockIsFree(home);
          return yield* read;
        });
      yield* Effect.gen(function* () {
        const added = yield* importSource(source);
        const library = yield* Library.Service;
        const history = yield* library.history;
        assert.strictEqual(sourceReadWithoutWriter, true);
        assert.strictEqual(stateSavedWithWriter, true);
        assert.strictEqual(history.events.length, 1);
        assert.strictEqual(yield* fs.readFileString(skillPath), bytes);
        assert.strictEqual(
          yield* fs.readFileString(
            join(originalTreePath(join(home, "originals"), added.snapshot_digest), "SKILL.md"),
          ),
          bytes,
        );
      }).pipe(
        Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFile: (path) => checkSourceRead(path, fs.readFile(path)),
          readFileString: (path, encoding) =>
            checkSourceRead(path, fs.readFileString(path, encoding)),
          rename: (from, to) =>
            Effect.gen(function* () {
              yield* fs.rename(from, to);
              if (to === join(home, "state.json"))
                stateSavedWithWriter = !(yield* homeLockIsFree(home));
            }),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testPlatformLayer)),
);

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
    assert.deepStrictEqual(yield* previewLibrarySource(source), {
      kind: "plain",
      skills: [{ name: "review", verbatim_path: "." }],
    });
    assert.strictEqual(yield* fs.exists(join(home, "state.json")), false);

    const added = yield* importSource(source).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
    );
    const state = yield* stateAt(home);
    assert.strictEqual(state.collections.length, 1);
    assert.strictEqual(state.skills[0]?.name, "review");
    assert.strictEqual(
      state.collection_versions[0]?.collection_version_id,
      added.collection_version_id,
    );
    assert.strictEqual(
      yield* fs.readFileString(
        join(originalTreePath(join(home, "originals"), added.snapshot_digest), "SKILL.md"),
      ),
      bytes,
    );
    assert.strictEqual(state.collections[0]?.upstream, undefined);

    yield* fs.writeFileString(join(source, "SKILL.md"), `${bytes}\nSecond snapshot.\n`);
    const addedAgain = yield* importSource(source).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
    );
    const refreshed = yield* stateAt(home);
    assert.strictEqual(addedAgain.collection_id, added.collection_id);
    assert.strictEqual(refreshed.collections.length, 1);
    assert.strictEqual(refreshed.imports.length, 2);
    assert.strictEqual(refreshed.skills[0]?.versions.length, 2);
    const failure = yield* planUpdates(added.collection_id).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
      Effect.provide(skitConfigurationLayer(home)),
      Effect.flip,
    );
    if (failure._tag !== "Library.CollectionNotUpdatable")
      return assert.fail(`Expected CollectionNotUpdatable, received ${failure._tag}`);
    assert.strictEqual(failure.subject_id, added.collection_id);
    assert.strictEqual(failure.source, source);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
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
    const added = yield* importSource(source).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
    );
    const state = yield* stateAt(home);
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
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("reports the retained package when its source disappears after publication", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-add-result-" });
    const source = join(root, "source");
    const home = join(root, "home");
    const memberPath = "skills/review";
    const bytes = "---\nname: review\ndescription: Review carefully\n---\nReview.\n";
    yield* fs.makeDirectory(join(source, memberPath), { recursive: true });
    yield* fs.writeFileString(join(source, memberPath, "SKILL.md"), bytes);
    yield* fs.writeFileString(
      join(source, "skit.json"),
      JSON.stringify({ slug: "tools", skills: [{ name: "review", path: memberPath }] }),
    );
    yield* initializeLibraryMachine(home);
    const added = yield* importSource(source).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        rename: (from, to) =>
          fs
            .rename(from, to)
            .pipe(
              Effect.andThen(
                to === join(home, "state.json")
                  ? fs.remove(source, { recursive: true })
                  : Effect.void,
              ),
            ),
      }),
    );
    assert.strictEqual(yield* fs.exists(source), false);
    assert.deepStrictEqual(added.skills, [{ name: "review", verbatim_path: memberPath }]);
    const state = yield* stateAt(home);
    assert.strictEqual(
      state.collection_versions[0]?.collection_version_id,
      added.collection_version_id,
    );
    assert.strictEqual(state.collection_versions[0]?.hash, added.snapshot_digest);
    assert.strictEqual(
      yield* fs.readFileString(
        join(
          originalTreePath(join(home, "originals"), added.snapshot_digest),
          memberPath,
          "SKILL.md",
        ),
      ),
      bytes,
    );
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("retains the exact bytes of a direct SKILL.md URL", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-add-direct-" });
    const home = join(root, "home");
    yield* initializeLibraryMachine(home);
    const bytes = "---\nname: review\ndescription: Review carefully\n---\n\nDo the review.\n";
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(bytes, { headers: { "content-type": "text/plain" } }),
        ),
      ),
    );
    const source = "https://github.com/acme/skills/blob/main/skills/review/SKILL.md";
    assert.deepStrictEqual(
      yield* previewLibrarySource(source).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      ),
      { kind: "plain", skills: [{ name: "review", verbatim_path: "." }] },
    );
    const added = yield* importSource(source).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    assert.strictEqual(
      yield* fs.readFileString(
        join(originalTreePath(join(home, "originals"), added.snapshot_digest), "SKILL.md"),
      ),
      bytes,
    );
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
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
      const hash = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
      const index = JSON.stringify({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "review",
            description: "Review.",
            type: "skill-md",
            url: "/review/SKILL.md",
            digest: hash,
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
        overrides: { codex: [join(root, "codex")] },
      },
      variantsPath: join(home, "variants"),
    };
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
        Effect.provide(skitConfigurationLayer(home)),
        Effect.provideService(HttpClient.HttpClient, client),
      );
    const added = yield* run(importSource(source));
    const before = yield* stateAt(home);
    assert.strictEqual(before.collections.length, 1);
    const skill = before.skills[0]!;
    assert.strictEqual(skill.collection_id, before.collections[0]?.collection_id);
    const view = yield* run(openLibraryView(home));
    const subjects = yield* run(view.readSubjects());
    assert.deepStrictEqual(
      subjects.map((subject) => [subject.kind, subject.id, subject.label]),
      [["collection", before.collections[0]?.collection_id, base]],
    );
    const enableInput = (enabled: boolean) => ({
      query: skill.skill_id,
      all: false,
      roots: options.roots,
      variantsPath: options.variantsPath,
      invocation: {
        harnesses: ["codex" as const],
        scope: { kind: "global" as const },
        enabled,
        dryRun: false,
      },
    });
    yield* writingTo(home, run(setLibraryEnabled(enableInput(true))));
    const enabled = yield* stateAt(home);
    assert.deepStrictEqual(enabled.enabled, [{ skill: skill.skill_id }]);
    assert.strictEqual(yield* fs.exists(join(root, "codex", "review", "SKILL.md")), true);
    assert.strictEqual(
      (yield* run(
        checkSubjects(skill.skill_id).pipe(Effect.provide(skitConfigurationLayer(home))),
      ))[0]?.source_status,
      "current",
    );
    artifact = updated;
    assert.strictEqual((yield* run(planUpdates(skill.skill_id)))[0]?.changed, true);
    const result = yield* run(
      updateSubjects(options, skill.skill_id).pipe(Effect.provide(rendererTestLayer())),
    );
    assert.isTrue(result[0] !== undefined && !("status" in result[0]) && result[0].changed);
    const after = yield* stateAt(home);
    assert.strictEqual(after.collections.length, 1);
    assert.strictEqual(after.skills[0]?.skill_id, added.skill_ids[0]);
    assert.strictEqual(after.skills[0]?.versions.length, 2);
    const sync = yield* run(
      Effect.gen(function* () {
        const library = yield* Library.Service;
        return yield* openSyncSession(
          { origin: "https://registry.test", remote: null },
          { base: yield* library.read },
        );
      }),
    );
    assert.strictEqual(sync._tag, "Ready");
    if (sync._tag === "Ready") assert.strictEqual(sync.plan.remote[0]?.kind, "collection");
    yield* writingTo(home, run(setLibraryEnabled(enableInput(false))));
    const disabled = yield* stateAt(home);
    assert.deepStrictEqual(disabled.enabled, []);
    yield* writingTo(
      home,
      run(
        // The Collection's only Skill can be removed, taking its Collection with it.
        executeRemove({
          query: skill.skill_id,
          dryRun: false,
        }).pipe(Effect.provide(skitConfigurationLayer(home))),
      ),
    );
    const removed = yield* stateAt(home);
    assert.deepStrictEqual(removed.skills, []);
    assert.deepStrictEqual(removed.collections, []);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("re-adding a changed local source adds a Skill Version and uses it", () =>
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
    const added = yield* importSource(source).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
    );
    yield* fs.writeFileString(
      join(source, "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\nsecond\n",
    );
    const addedAgain = yield* writingTo(home, importSource(source));
    assert.strictEqual(added.action, "added");
    assert.strictEqual(addedAgain.action, "updated");
    const after = yield* stateAt(home);
    assert.strictEqual(after.skills[0]?.versions.length, 2);
    assert.strictEqual(
      currentSkillVersion(after, after.skills[0]!)?.skill_version_id,
      after.skills[0]?.versions[1]?.skill_version_id,
    );
    assert.strictEqual(after.collection_versions.length, 2);
    assert.strictEqual(addedAgain.collection_id, added.collection_id);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
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
    const added = yield* importSource(source).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
    );
    yield* fs.writeFileString(
      join(source, ".skit-ownership.json"),
      '{"schemaVersion":1,"projectionId":"projection-test"}\n',
    );
    const reAdd = importSource(source).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
    );
    const load = stateAt(home);

    const first = yield* reAdd;
    const second = yield* reAdd;
    assert.strictEqual(first.action, "unchanged");
    assert.strictEqual(second.action, "unchanged");
    const after = yield* load;

    assert.strictEqual(first.snapshot_digest, added.snapshot_digest);
    assert.strictEqual(second.snapshot_digest, added.snapshot_digest);
    assert.strictEqual(after.collection_versions.length, 1);
    assert.strictEqual(after.imports.length, 1);
    assert.strictEqual(after.skills[0]?.versions.length, 1);
    assert.strictEqual(
      yield* fs.exists(
        join(
          originalTreePath(join(home, "originals"), added.snapshot_digest),
          ".skit-ownership.json",
        ),
      ),
      false,
    );
    assert.ok(
      after.imports.every(
        (sourceImport) => sourceImport.collection_version_id === added.collection_version_id,
      ),
    );
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
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
    const currentHash = yield* deterministicTreeHash(skill);
    const importAt = (commit: string, importedAt: string) =>
      Effect.scoped(
        writingTo(
          home,
          importCollectionIn(home)({
            source: { type: "github", owner: "acme", repository: "skills" },
            input: "https://github.com/acme/skills.git",
            revision: { kind: "commit", commit },
            importedAt,
            skills: [{ name: "review", sourcePath: skill, relativePath: "review", currentHash }],
            lockFileEntries: [],
          }),
        ),
      );
    const load = stateAt(home);

    yield* importAt("a".repeat(40), "2026-09-16T01:00:00.000Z");
    yield* importAt("b".repeat(40), "2026-09-16T02:00:00.000Z");
    const recorded = yield* load;
    yield* importAt("b".repeat(40), "2026-09-16T03:00:00.000Z");
    const repeated = yield* load;

    // The new commit is recorded as its own import of the same bytes.
    assert.strictEqual(recorded.collection_versions.length, 1);
    assert.deepStrictEqual(
      recorded.imports.map((sourceImport) => sourceImport.revision),
      ["a".repeat(40), "b".repeat(40)],
    );
    assert.deepStrictEqual(repeated.imports, recorded.imports);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("records the Registry Release a Collection is added from, so sync can refetch it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-registry-add-" });
    const home = join(root, "home");
    yield* initializeLibraryMachine(home);
    const tools = yield* boundSkit(join(root, "tools"), "alice");
    const bytes = yield* archiveBytes(tools, join(root, "tools.zip"));
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(new Uint8Array(bytes), {
            headers: { "content-type": "application/zip", "skit-release-version": "1.2.3" },
          }),
        ),
      ),
    );
    yield* importSource({
      type: "registry",
      namespace: "alice",
      slug: "tools",
      version: "1.2.3",
    }).pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
      Effect.provide(skitConfigurationLayer(home)),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    const state = yield* stateAt(home);
    assert.deepStrictEqual(
      state.imports.map((sourceImport) => sourceImport.revision),
      ["1.2.3"],
    );
    // A Release the Registry can serve again needs no snapshot of its own.
    assert.deepStrictEqual((yield* libraryManifestFromLocalState(state)).snapshot_digests, []);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
