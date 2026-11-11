import { pinnedCollections } from "./storybook-fixtures.js";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";

/**
 * A disposable account with no SKIT Library and a folder holding swyxio's two real skills, cli-ux
 * and skill-cutter, as a person keeps a checkout of skills they want to try.
 */
export const makeCollectionLifecycleFixture = Effect.fn("Storybook.makeCollectionLifecycleFixture")(
  function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const collections = yield* pinnedCollections;
    const source = join(root, "dev", "swyx-skills");
    yield* fs.makeDirectory(join(root, "dev"), { recursive: true });
    yield* fs.copy(join(collections, "swyxio"), source);
    return {
      source,
      home: join(root, ".skit"),
      inventory: { home: root, configHome: join(root, ".config"), overrides: {} },
      /** Whether each folder holds a skill, by its SKILL.md. */
      skillsAt: (paths: readonly string[]) =>
        Effect.forEach(paths, (path) => fs.exists(join(path, "SKILL.md"))),
      /** Whether the source folder still holds both skills. */
      sourceKept: Effect.forEach(["cli-ux", "skill-cutter"], (name) =>
        fs.exists(join(source, name, "SKILL.md")),
      ).pipe(Effect.map((kept) => !kept.includes(false))),
    };
  },
);
