import { it as effectIt } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { LibraryStore, libraryStoreLayer, retainedTreePath } from "@smolai/skit-core";
import { readDescriptionLoad } from "../src/workflows/library/collection-load.js";
import { addLibrarySourceEffect } from "../src/workflows/library/add.js";
import { initializeLibraryMachine } from "./helpers/library-home.js";
import { testPlatformLayer } from "./helpers/platform.js";

import { describe, expect, it } from "vitest";
import {
  descriptionLoadMessage,
  largeCollectionWarning,
} from "../src/workflows/library/collection-load.js";

describe("collection load warning", () => {
  it("warns strictly above 100 and renders actionable guidance", () => {
    expect(largeCollectionWarning(100)).toBeUndefined();
    const warning = largeCollectionWarning(101)!;
    expect(warning).toContain("101 skills");
    expect(warning).toContain("skit doctor");
  });
  it("reports aggregate characters and incomplete measurements without inventing a budget", () => {
    const message = descriptionLoadMessage({ skills: 120, characters: 24000, unknown: 2 });
    expect(message).toContain("24,000 description characters");
    expect(message).toContain("2 unmeasured");
    expect(message).not.toContain("budget");
  });
});

effectIt.effect(
  "measures selected retained bytes and reports unreadable or malformed descriptions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-description-load-" });
      const home = join(root, "home");
      const source = join(root, "source");
      yield* initializeLibraryMachine(home);
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(
        join(source, "SKILL.md"),
        '---\nname: review\ndescription: "A😀é"\n---\n',
      );
      const first = yield* addLibrarySourceEffect(source).pipe(
        Effect.provide(libraryStoreLayer({ home })),
      );
      const firstState = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
        Effect.provide(libraryStoreLayer({ home })),
      );
      const originalSkill = firstState.skills[0]!;
      yield* fs.writeFileString(
        join(source, "SKILL.md"),
        '---\nname: review\ndescription: "A much longer new description"\n---\n',
      );
      yield* addLibrarySourceEffect(source).pipe(Effect.provide(libraryStoreLayer({ home })));
      const state = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
        Effect.provide(libraryStoreLayer({ home })),
      );
      const skill = {
        ...state.skills[0]!,
        local_version_id: originalSkill.versions[0]!.skill_version_id,
      };
      const selectedState = { ...state, skills: [skill] };
      const originals = join(home, "originals");
      const measure = readDescriptionLoad(selectedState, originals, [skill]);
      expect(yield* measure).toEqual({ skills: 1, characters: 3, unknown: 0 });
      const retainedFile = join(retainedTreePath(originals, first.snapshot_digest), "SKILL.md");
      for (const text of [
        "---\nname: review\ndescription: [bad\n---\n",
        "---\nname: review\ndescription: 123\n---\n",
      ]) {
        yield* fs.writeFileString(retainedFile, text);
        expect(yield* measure).toEqual({ skills: 1, characters: 0, unknown: 1 });
      }
      yield* fs.remove(retainedFile);
      expect(yield* measure).toEqual({ skills: 1, characters: 0, unknown: 1 });
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
