import { it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import * as Library from "../src/library/library.js";
import { emptyLibraryState } from "../src/library/library-state.js";
import { collectionVersionPath } from "../src/library/collection-version.js";
import { readDescriptionLoad } from "../src/library/internal/session/description-load.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect("measures selected retained bytes and reports unreadable or malformed descriptions", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-description-load-" });
    const home = join(root, "home");
    const source = join(root, "source");
    yield* fs.makeDirectory(source);
    yield* fs.writeFileString(
      join(source, "SKILL.md"),
      '---\nname: review\ndescription: "A😀é"\n---\n',
    );
    const importSource = Effect.gen(function* () {
      const owner = yield* Library.Service;
      const request = Option.getOrThrow(
        yield* localImportRequest(source, "2026-11-06T00:00:00.000Z"),
      );
      return yield* owner.import.collection(request);
    });
    const first = yield* importSource.pipe(
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
    );
    const firstState = yield* Effect.flatMap(Library.Service, (library) => library.read).pipe(
      Effect.map((snapshot) =>
        snapshot._tag === "Present" ? snapshot.state : emptyLibraryState(),
      ),
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
    );
    const originalSkill = firstState.skills[0]!;
    yield* fs.writeFileString(
      join(source, "SKILL.md"),
      '---\nname: review\ndescription: "A much longer new description"\n---\n',
    );
    yield* importSource.pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));
    const state = yield* Effect.flatMap(Library.Service, (library) => library.read).pipe(
      Effect.map((snapshot) =>
        snapshot._tag === "Present" ? snapshot.state : emptyLibraryState(),
      ),
      Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
    );
    const skill = {
      ...state.skills[0]!,
      local_version_id: originalSkill.versions[0]!.skill_version_id,
    };
    const selectedState = { ...state, skills: [skill] };
    const originals = join(home, "originals");
    const measure = readDescriptionLoad(selectedState, originals, [skill]);
    expect(yield* measure).toEqual({ skills: 1, characters: 3, unknown: 0 });
    const importedFile = join(collectionVersionPath(originals, first.snapshotDigest), "SKILL.md");
    for (const text of [
      "---\nname: review\ndescription: [bad\n---\n",
      "---\nname: review\ndescription: 123\n---\n",
    ]) {
      yield* fs.writeFileString(importedFile, text);
      expect(yield* measure).toEqual({ skills: 1, characters: 0, unknown: 1 });
    }
    yield* fs.remove(importedFile);
    expect(yield* measure).toEqual({ skills: 1, characters: 0, unknown: 1 });
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
