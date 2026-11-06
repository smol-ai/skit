import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import * as Library from "@smolai/skit-core/library";
import { makeMachineId } from "@smolai/skit-core/universal/consumer";
import { deterministicTreeHash } from "@smolai/skit-core/author";
import { readLibraryManifest } from "@smolai/skit-core/library/session";

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

export const makeEnablePreviewFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-story-library-" });
  const codexRoot = join(home, "codex");
  yield* fs.makeDirectory(codexRoot);
  return {
    home,
    codexRoot,
    installedEmpty: fs.readDirectory(codexRoot).pipe(Effect.map((files) => files.length === 0)),
  };
});
export const makeDoctorPreviewFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-doctor-story-" });
  const home = join(root, "library"),
    account = join(root, "account");
  const skillsRoot = join(account, ".agents", "skills"),
    path = join(skillsRoot, "review");
  return {
    root,
    home,
    account,
    skillsRoot,
    path,
    installed: fs.exists(join(path, "SKILL.md")),
    document: fs.readFileString(join(path, "SKILL.md")),
  };
});

export const makeSyncJourneyFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-story-sync-" });
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
    const portable = yield* readLibraryManifest(seedHome);
    const manifest = {
      ...portable,
      enabled: portable.skills.map((skill) => ({ skill: skill.skill_id })),
    };
    const archives = yield* library.content.pack(snapshot);
    return { manifest, archives };
  }).pipe(Effect.provide(Library.layer({ home: seedHome, routing: { _tag: "None" } })));
  return { workspace, seeded };
});
