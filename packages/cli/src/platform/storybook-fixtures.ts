import { Effect, FileSystem } from "effect";
import { dirname, join } from "node:path";
import * as Library from "@smolai/skit-core/library";
import { makeMachineId } from "@smolai/skit-core/universal/consumer";
import { deterministicTreeHash } from "@smolai/skit-core/author";

/**
 * The Collections pinned in test/fixtures/collections, found from source or from the bundled
 * storybook. A compiled dist/test holds only the manifest, so look for a Collection's files.
 */
export const pinnedCollections = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  let directory = import.meta.dirname;
  while (!(yield* fs.exists(join(directory, "test", "fixtures", "collections", "swyxio")))) {
    if (dirname(directory) === directory)
      return yield* Effect.die("The pinned Collections in test/fixtures/collections are missing");
    directory = dirname(directory);
  }
  return join(directory, "test", "fixtures", "collections");
});

/** Real retained bytes and owner-generated identities, shared by the preview journeys. */
export const importReview = Effect.fn("Storybook.importReview")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const library = yield* Library.Service;
  const sourcePath = join(root, "review-tools");
  yield* fs.makeDirectory(sourcePath, { recursive: true });
  yield* fs.writeFileString(
    join(sourcePath, "SKILL.md"),
    "---\nname: review\ndescription: Review code changes.\n---\n# Review\nPreserve the intended behavior.\n",
  );
  return yield* library.import.collection({
    machineId: makeMachineId(),
    source: { type: "local", path: sourcePath },
    input: sourcePath,
    importedAt: "2026-01-01T00:00:00.000Z",
    skills: [
      {
        name: "review",
        sourcePath,
        relativePath: ".",
        currentHash: yield* deterministicTreeHash(sourcePath),
      },
    ],
    lockFileEntries: [],
  });
});

/**
 * A disposable home folder for one journey: the fixture person's `~`. Resolved, so the paths the
 * CLI prints are the ones under it.
 */
export const makeJourneyHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "skit-journey-" }));
});

export const makeEnablePreviewFixture = Effect.fn("Storybook.makeEnablePreviewFixture")(function* (
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const codexRoot = join(home, "codex");
  yield* fs.makeDirectory(codexRoot);
  return {
    home,
    codexRoot,
    installedEmpty: fs.readDirectory(codexRoot).pipe(Effect.map((files) => files.length === 0)),
  };
});
export const makeSyncJourneyFixture = Effect.fn("Storybook.makeSyncJourneyFixture")(function* (
  workspace: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const seedHome = join(workspace, "seed");
  const machineId = makeMachineId();
  const seeded = yield* Effect.gen(function* () {
    const library = yield* Library.Service;
    for (const name of ["review", "testing", "docs"]) {
      const sourcePath = join(workspace, name);
      yield* fs.makeDirectory(sourcePath);
      yield* fs.writeFileString(
        join(sourcePath, "SKILL.md"),
        `# ${name}\nFixture Skill for sync preview.\n`,
      );
      yield* library.import.collection({
        machineId,
        source: { type: "github", owner: "fixture", repository: name },
        input: sourcePath,
        importedAt: "2026-01-01T00:00:00.000Z",
        skills: [
          {
            name,
            sourcePath,
            relativePath: ".",
            currentHash: yield* deterministicTreeHash(sourcePath),
          },
        ],
        lockFileEntries: [],
      });
    }
    const snapshot = yield* library.read;
    if (snapshot._tag === "Absent") return yield* Effect.die("Expected seeded Library");
    const portable = yield* library.manifest;
    const manifest = {
      ...portable,
      enabled: portable.skills.map((skill) => ({ skill: skill.skill_id })),
    };
    const archives = yield* library.content.pack(snapshot);
    return { manifest, archives };
  }).pipe(
    Effect.provide(
      Library.layer({
        home: seedHome,
        roots: { home: seedHome, configHome: join(seedHome, "config"), overrides: {} },
      }),
    ),
  );
  return { workspace, seeded };
});
