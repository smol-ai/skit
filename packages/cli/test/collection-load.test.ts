import { it as effectIt } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import {
  deterministicTreeHash,
  LibraryStore,
  libraryStoreLayer,
  collectionVersionPath,
  type ImportRequestSkill,
} from "@smolai/skit-core";
import { readDescriptionLoad } from "../src/workflows/library/collection-load.js";
import { importSource } from "../src/library-application/import-source.js";
import {
  initializeLibraryMachine,
  libraryHome,
  importCollectionIn,
  writingTo,
} from "./helpers/library-home.js";
import { presentSetEnabled } from "../src/handlers/library/set-enabled.js";
import { libraryCommandConfiguration } from "../src/commands/library-configuration.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
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
  "measures current collection members while keeping removed skills individually selectable",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-collection-membership-" });
      const home = yield* libraryHome({ home: join(root, "home") });
      yield* initializeLibraryMachine(home.home);
      const source = join(root, "source");
      const members: ImportRequestSkill[] = [];
      for (const name of ["keep", "removed"]) {
        const path = join(source, name);
        yield* fs.makeDirectory(path, { recursive: true });
        yield* fs.writeFileString(
          join(path, "SKILL.md"),
          `---\nname: ${name}\ndescription: "A😀é"\n---\n`,
        );
        members.push({
          name,
          sourcePath: path,
          relativePath: name,
          currentHash: yield* deterministicTreeHash(path),
        });
      }
      const importMembers = (skills: typeof members, importedAt: string) =>
        home.owned(
          writingTo(
            home.home,
            importCollectionIn(home.home)({
              source: { type: "local", path: source },
              input: source,
              importedAt,
              skills,
              observations: [],
            }),
          ),
        );
      const first = yield* importMembers(members, "2026-10-12T00:00:00.000Z");
      yield* fs.remove(join(source, "removed"), { recursive: true });
      yield* importMembers(
        members.filter((member) => member.name === "keep"),
        "2026-10-13T00:00:00.000Z",
      );
      expect((yield* home.durable).skills.map((skill) => skill.name).sort()).toEqual([
        "keep",
        "removed",
      ]);
      const configuration = yield* libraryCommandConfiguration({
        home: Option.some(home.home),
        codexRoot: Option.none(),
        claudeRoot: Option.none(),
        opencodeRoot: Option.none(),
        devinRoot: [],
      });
      const interaction = yield* makeScriptedInteraction(["skills", []]);
      yield* home.owned(
        presentSetEnabled({
          action: "enable",
          enabled: true,
          subject: first.collection?.collection_id,
          scope: { kind: "global" },
          cwd: root,
          all: false,
          dryRun: true,
          interactive: true,
          configuration,
        }).pipe(Effect.provide(interaction.layer)),
      );
      const prompts = yield* interaction.prompts;
      expect(prompts[0]?.choices.find((choice) => choice.value === "collection")?.label).toBe(
        "Enable whole collection · 1 skills · 3 description characters",
      );
      expect(prompts[1]?.choices.map((choice) => choice.value).sort()).toEqual(["keep", "removed"]);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

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
      const first = yield* importSource(source).pipe(Effect.provide(libraryStoreLayer({ home })));
      const firstState = yield* Effect.flatMap(LibraryStore, (store) => store.load).pipe(
        Effect.provide(libraryStoreLayer({ home })),
      );
      const originalSkill = firstState.skills[0]!;
      yield* fs.writeFileString(
        join(source, "SKILL.md"),
        '---\nname: review\ndescription: "A much longer new description"\n---\n',
      );
      yield* importSource(source).pipe(Effect.provide(libraryStoreLayer({ home })));
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
      const importedFile = join(
        collectionVersionPath(originals, first.snapshot_digest),
        "SKILL.md",
      );
      for (const text of [
        "---\nname: review\ndescription: [bad\n---\n",
        "---\nname: review\ndescription: 123\n---\n",
      ]) {
        yield* fs.writeFileString(importedFile, text);
        expect(yield* measure).toEqual({ skills: 1, characters: 0, unknown: 1 });
      }
      yield* fs.remove(importedFile);
      expect(yield* measure).toEqual({ skills: 1, characters: 0, unknown: 1 });
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
