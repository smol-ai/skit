import { deterministicTreeHash } from "@smolai/skit-core/author";
import * as Library from "@smolai/skit-core/library";
type ImportRequestSkill = Parameters<
  Library.Interface["import"]["collection"]
>[0]["skills"][number];
import { it as effectIt } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";

import {
  descriptionLoadMessage,
  largeCollectionWarning,
} from "../src/library/presentation/description-size.js";

import {
  initializeLibraryMachine,
  libraryHome,
  importCollectionIn,
  writingTo,
} from "./helpers/library-home.js";
import { presentSetEnabled } from "../src/library/enable.js";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";
import { testPlatformLayer } from "./helpers/platform.js";

import { describe, expect, it } from "vitest";

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
              lockFileEntries: [],
            }),
          ),
        );
      const first = yield* importMembers(members, "2026-10-12T00:00:00.000Z");
      yield* fs.remove(join(source, "removed"), { recursive: true });
      yield* importMembers(
        members.filter((member) => member.name === "keep"),
        "2026-10-13T00:00:00.000Z",
      );
      const view = yield* home.owned(
        Effect.flatMap(Library.Service, (library) => library.enable.open()).pipe(
          Effect.map((selection) => selection.view),
        ),
      );
      expect(yield* view.descriptionLoad({ collection: first.collection.collection_id })).toEqual({
        skills: 1,
        characters: 3,
        unknown: 0,
      });
      expect(
        yield* view.descriptionLoad({ skills: first.skills.map((skill) => skill.skill_id) }),
      ).toEqual({
        skills: 2,
        characters: 6,
        unknown: 0,
      });
      expect((yield* home.durable).skills.map((skill) => skill.name).sort()).toEqual([
        "keep",
        "removed",
      ]);

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
        }).pipe(Effect.provide(interaction.layer)),
      );
      const prompts = yield* interaction.prompts;
      expect(prompts[0]?.choices.find((choice) => choice.value === "collection")?.label).toBe(
        "Enable whole collection · 1 skills · 3 description characters",
      );
      expect(prompts[1]?.choices.map((choice) => choice.value).sort()).toEqual(["keep", "removed"]);
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
