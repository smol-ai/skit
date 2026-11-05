import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import * as Library from "../src/library/library.js";
import { LibraryState } from "../src/library/library-state.js";
import { openSetupReview, runSetup } from "../src/library/setup.js";
import { skitLayer } from "../src/platform/layer.js";

for (const boundary of ["normal", "recorded", "backup", "successor", "empty"] as const)
  it.effect(`setup updates only selected Skills through ${boundary}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-selection-" }),
      );
      const home = join(root, "home");
      const agents = join(root, ".agents", "skills");
      const configuration = {
        home: root,
        configHome: join(root, "config"),
        overrides: { codex: [agents] },
      };
      const layer = Library.layer({ home, routing: { _tag: "Configured", ...configuration } });
      const importing = (body: string, importedAt: string) =>
        Effect.gen(function* () {
          const library = yield* Library.Service;
          const skills = [];
          for (const name of ["alpha", "beta"]) {
            const path = join(root, "source", name);
            yield* fs.makeDirectory(path, { recursive: true });
            yield* fs.writeFileString(
              join(path, "SKILL.md"),
              `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`,
            );
            skills.push({
              name,
              sourcePath: path,
              relativePath: name,
              currentHash: yield* deterministicTreeHash(path),
            });
          }
          return yield* library.import.collection({
            input: join(root, "source"),
            source: { type: "local", path: join(root, "source") },
            importedAt,
            skills,
            lockFileEntries: [],
          });
        });
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const imported = yield* importing("old", "2026-11-01T00:00:00Z");
        const plan = yield* library.plan(
          {
            _tag: "Enabled",
            changes: [
              {
                _tag: "Enable",
                members: "whole",
                subject: { _tag: "Collection", id: imported.collection.collection_id },
                where: [{ kind: "global" }],
              },
            ],
          },
          { base: yield* library.read },
        );
        yield* library.apply({ _tag: "Apply", plan });
        yield* importing("new", "2026-11-02T00:00:00Z");
      }).pipe(Effect.provide(layer));
      const beta = join(agents, "beta");
      const betaBytes = yield* fs.readFileString(join(beta, "SKILL.md"));
      const betaMarker = yield* fs.readFileString(join(beta, ".skit-ownership.json"));
      const before = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryState))(
        yield* fs.readFileString(join(home, "state.json")),
      );
      let stopped = false;
      const files: FileSystem.FileSystem = {
        ...fs,
        rename: (from, to) =>
          Effect.gen(function* () {
            yield* fs.rename(from, to);
            if (stopped) return;
            let stop =
              boundary === "backup" &&
              from === join(agents, "alpha") &&
              to.includes(".skit-backups/pending-");
            stop ||=
              boundary === "successor" &&
              from.includes(".skit-stage-") &&
              to === join(agents, "alpha");
            if (boundary === "recorded" && to === join(home, "state.json")) {
              const state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryState))(
                yield* fs.readFileString(to),
              ).pipe(Effect.orDie);
              stop ||= state.operations.some(
                (operation) =>
                  operation._tag === "Pending" &&
                  operation.steps.some(
                    (step) => step.step._tag === "Update" && step.status === "Pending",
                  ),
              );
            }
            if (stop) {
              stopped = true;
              return yield* Effect.die("interrupted selected update");
            }
          }),
      };
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          const setup = {
            libraryHome: home,
            inventory: configuration,
            persistRoots: false,
            probePath: "",
            skillsStateHome: join(root, "state"),
          };
          const scan = yield* runSetup(setup);
          const alpha = scan.changes?.find((fact) => fact.name === "alpha");
          if (!alpha) return yield* Effect.die("Missing Alpha update");
          const review = yield* openSetupReview(setup, scan, { installOptions: configuration });
          const plan = yield* review.prepare({
            sources: [],
            copies: [],
            decisions: [],
            reconcileExisting: false,
            reconciliationSkills: boundary === "empty" ? [] : [alpha.skillId],
          });
          assert.deepStrictEqual(
            plan.summary.changes.map((fact) => fact.name),
            boundary === "empty" ? [] : ["alpha"],
          );
          yield* plan.apply((_, effect) => effect);
        }).pipe(
          Effect.provide(layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, files)))),
        ),
      );
      assert.strictEqual(
        result._tag,
        boundary === "normal" || boundary === "empty" ? "Success" : "Failure",
      );
      assert.strictEqual(stopped, boundary !== "normal" && boundary !== "empty");
      for (let attempt = 0; attempt < 2; attempt++) {
        yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          assert.deepStrictEqual(library.startup.stopped, []);
          const snapshot = yield* library.read;
          if (snapshot._tag !== "Present") return assert.fail("Missing Library");
          assert.deepStrictEqual(
            snapshot.state.installed_skills.filter((row) => row.path === beta),
            before.installed_skills.filter((row) => row.path === beta),
          );
        }).pipe(Effect.provide(layer));
        assert.strictEqual(yield* fs.readFileString(join(beta, "SKILL.md")), betaBytes);
        assert.strictEqual(
          yield* fs.readFileString(join(beta, ".skit-ownership.json")),
          betaMarker,
        );
        assert.include(
          yield* fs.readFileString(join(agents, "alpha", "SKILL.md")),
          boundary === "empty" ? "old" : "new",
        );
      }
      // Ordinary Update still includes Beta; an explicit empty selection plans nothing.
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const base = yield* library.read;
        assert.deepStrictEqual(
          (yield* library.plan({ _tag: "Update", skills: [] }, { base })).changes,
          [],
        );
        assert.isTrue(
          (yield* library.plan({ _tag: "Update" }, { base })).changes.some(
            (change) =>
              "skillId" in change &&
              change.skillId === before.skills.find((skill) => skill.name === "beta")?.skill_id,
          ),
        );
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
