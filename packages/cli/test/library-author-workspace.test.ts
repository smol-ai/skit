import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { LibraryStore, retainedTreePath, skitLayer } from "@smolai/skit-core";
import { ensureAuthoredWorkspaceEffect } from "../src/workflows/author/initialization.js";
import {
  copySkitFixtureEffect,
  initializeLibraryMachine,
  libraryHome,
  scratch,
} from "./helpers/library-home.js";

it.effect(
  "registers and refreshes an authored workspace as Skill Versions and Retained Trees",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* scratch("skit-portable-author-");
      const source = join(root, "source");
      yield* copySkitFixtureEffect("authored", source);
      const home = yield* libraryHome({ home: join(root, "home") });
      yield* initializeLibraryMachine(home.home);
      const options = {
        ...home.bindings,
        libraryHome: home.home,
        workspaceId: () => `workspace_${"a".repeat(32)}`,
      };
      const first = yield* home.owned(ensureAuthoredWorkspaceEffect(source, options));
      assert.ok(first.entry);
      assert.strictEqual(
        first.entry.collection?.upstream?.source_identity.kind,
        "authored-workspace",
      );
      const firstState = yield* home.owned(Effect.flatMap(LibraryStore, (store) => store.load));
      assert.strictEqual(firstState.retained_copies.length, 1);
      const firstTree = firstState.retained_copies[0];
      assert.ok(firstTree);
      assert.strictEqual(
        yield* fs.exists(join(retainedTreePath(home.originals, firstTree.digest), "skit.json")),
        true,
      );

      const skillPath = join(source, "skills", "review", "SKILL.md");
      yield* fs.writeFileString(skillPath, `${yield* fs.readFileString(skillPath)}\nUpdated.\n`);
      const refreshed = yield* home.owned(ensureAuthoredWorkspaceEffect(source, options));
      assert.ok(refreshed.entry);
      assert.strictEqual(
        refreshed.entry.collection?.collection_id,
        first.entry.collection?.collection_id,
      );
      const state = yield* home.owned(Effect.flatMap(LibraryStore, (store) => store.load));
      assert.strictEqual(state.collections.length, 1);
      assert.strictEqual(state.retained_copies.length, 2);
      assert.strictEqual(state.skills.find((skill) => skill.name === "review")?.versions.length, 2);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
