import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { planChanges } from "../src/library/plan-changes.js";
import * as InstalledSkills from "../src/library/installed-skills.js";
import { decodeLibraryState, libraryManifestFromLocalState } from "../src/library/library-state.js";
import { skitLayer } from "../src/platform/layer.js";
import { fixture } from "./helpers/library-values.js";

for (const aliased of [false, true])
  it.effect(
    aliased
      ? "Update assigns aliased copies to the smallest root string in either order"
      : "Update assigns nested copies to the innermost repository in either list order",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "skit-nested-repositories-" }),
        );
        const outerRoot = join(root, "outer"),
          innerRoot = aliased ? join(root, "alias") : join(outerRoot, "inner"),
          destination = join(innerRoot, ".agents", "skills");
        yield* fs.makeDirectory(outerRoot, { recursive: true });
        if (aliased) yield* fs.symlink(outerRoot, innerRoot);
        yield* fs.makeDirectory(destination, { recursive: true });
        const { state } = yield* fixture;
        const skill = state.skills[0]!,
          installed = state.installed_skills[0]!;
        const outer = {
          root: outerRoot,
          enabled: [{ skill: skill.skill_id }],
          invocation_policies: { [skill.skill_id]: "explicit" },
        };
        const inner = {
          root: innerRoot,
          enabled: [{ skill: skill.skill_id }],
          invocation_policies: { [skill.skill_id]: "implicit" },
        };
        const files = yield* InstalledSkills.make({ home: root, configHome: root, overrides: {} });
        for (const repositories of [
          [outer, inner],
          [inner, outer],
        ]) {
          const base = yield* decodeLibraryState({
            ...state,
            repositories,
            installed_skills: [
              { ...installed, root: destination, path: join(destination, skill.name) },
            ],
          });
          yield* libraryManifestFromLocalState(base);
          const planned = yield* planChanges(
            join(root, "library"),
            base,
            { _tag: "Update", skills: [skill.skill_id] },
            [],
          ).pipe(Effect.provideService(InstalledSkills.Service, files));
          assert.deepStrictEqual(
            planned.routes.find(
              (route) => route.scope.kind === "repository" && route.scope.root === outerRoot,
            )?.destinations,
            [],
          );
          assert.deepStrictEqual(
            planned.routes.find(
              (route) => route.scope.kind === "repository" && route.scope.root === innerRoot,
            )?.destinations,
            [{ destination: installed.destination, root: destination }],
          );
          assert.strictEqual(planned.changes.length, 1);
          const change = planned.changes[0]!;
          assert.strictEqual(change._tag, "KeepDeleted");
          assert.isTrue("invocation" in change);
          if ("invocation" in change) assert.strictEqual(change.invocation, "implicit");
        }
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
