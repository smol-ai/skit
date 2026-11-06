import { assert, it } from "@effect/vitest";
import { Cause, Effect, FileSystem, Layer, Schema } from "effect";
import { join } from "node:path";
import { deterministicTreeHash } from "../src/artifact/skit.js";
import * as Library from "../src/library/library.js";
import { LibraryState } from "../src/library/library-state.js";
import { openSetupReview, runSetup } from "../src/library/setup.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import { inspectLibrary, saveLibrary } from "./helpers/library-store.js";
import { skitLayer } from "../src/platform/layer.js";

for (const boundary of [
  "normal",
  "recorded",
  "backup",
  "successor",
  "empty",
  "multiple",
  "local",
  "legacy-recorded",
  "legacy-backup",
  "rename",
  "occupied",
] as const)
  it.effect(`setup updates only selected Skills through ${boundary}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "skit-selection-" }),
      );
      const home = join(root, "home");
      const agents = join(root, ".agents", "skills");
      const claude = join(root, ".claude", "skills");
      const multiple = boundary === "multiple" || boundary === "local";
      const legacy = boundary === "legacy-recorded" || boundary === "legacy-backup";
      const interruption =
        boundary === "legacy-recorded"
          ? "recorded"
          : boundary === "legacy-backup"
            ? "backup"
            : boundary;
      if (multiple) yield* fs.makeDirectory(claude, { recursive: true });
      const configuration = {
        home: root,
        configHome: join(root, "config"),
        overrides: { codex: [agents], ...(multiple ? { "claude-code": [claude] } : {}) },
      };
      const layer = Library.layer({ home, roots: configuration });
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
      if (boundary === "local")
        yield* fs.writeFileString(
          join(agents, "alpha", "SKILL.md"),
          "---\nname: alpha\ndescription: alpha\n---\nlocal choice\n",
        );
      if (boundary === "rename" || boundary === "occupied") {
        const saved = yield* inspectLibrary(home);
        if (!saved.present) return assert.fail("Missing rename fixture");
        yield* saveLibrary(home, {
          ...saved.state,
          skills: saved.state.skills.map((skill) =>
            skill.name === "alpha" ? { ...skill, name: "alpha-renamed" } : skill,
          ),
        });
      }
      if (boundary === "occupied")
        yield* fs.copy(join(agents, "beta"), join(agents, "alpha-renamed"));
      const beta = join(agents, "beta");
      const betaBytes = yield* fs.readFileString(join(beta, "SKILL.md"));
      const betaMarker = yield* fs.readFileString(join(beta, ".skit-ownership.json"));
      const before = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryState))(
        yield* fs.readFileString(join(home, "state.json")),
      );
      let stopped = false;
      let backedUpAlpha: string | undefined;
      const files: FileSystem.FileSystem = {
        ...fs,
        rename: (from, to) =>
          Effect.gen(function* () {
            yield* fs.rename(from, to);
            if (from === join(agents, "alpha") && to.includes(".skit-backups/pending-"))
              backedUpAlpha = to;
            if (stopped) return;
            let stop =
              interruption === "backup" &&
              from === join(agents, "alpha") &&
              to.includes(".skit-backups/pending-");
            stop ||=
              interruption === "successor" &&
              from.includes(".skit-stage-") &&
              to === join(agents, "alpha");
            if (interruption === "recorded" && to === join(home, "state.json")) {
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
          const review = yield* openSetupReview(setup, { installOptions: configuration });
          const scan = review.scan;
          const alpha = scan.changes?.find(
            (fact) =>
              fact.skillId === before.skills.find((skill) => skill.path === "alpha")?.skill_id,
          );
          if (!alpha) return yield* Effect.die("Missing Alpha update");
          const plan = yield* review.prepare({
            sources: [],
            copies: [],
            decisions: [],
            reconcileExisting: false,
            reconciliationSkills: boundary === "empty" ? [] : [alpha.skillId],
            versionChoices:
              boundary === "local"
                ? [{ skillId: alpha.skillId, version: "local", path: join(agents, "alpha") }]
                : [],
          });
          assert.deepStrictEqual(
            plan.summary.changes.map((fact) => fact.name),
            boundary === "occupied"
              ? ["alpha-renamed", "alpha-renamed"]
              : boundary === "empty"
                ? []
                : boundary === "rename"
                  ? ["alpha-renamed", "alpha-renamed"]
                  : multiple
                    ? ["alpha", "alpha"]
                    : ["alpha"],
          );
          if (boundary === "occupied")
            assert.isTrue(plan.summary.changes.some((fact) => fact.status === "protected"));
          yield* plan.apply((_, effect) => effect);
        }).pipe(
          Effect.provide(layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, files)))),
        ),
      );
      assert.strictEqual(
        result._tag,
        ["normal", "empty", "multiple", "local", "rename"].includes(boundary)
          ? "Success"
          : "Failure",
        result._tag === "Failure" ? Cause.pretty(result.cause) : undefined,
      );
      assert.strictEqual(
        stopped,
        !["normal", "empty", "multiple", "local", "rename", "occupied"].includes(boundary),
      );
      if (boundary === "occupied" && result._tag === "Failure")
        assert.include(Cause.pretty(result.cause), "ChangeChoiceRequired");
      if (legacy) {
        const state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LibraryState))(
          yield* fs.readFileString(join(home, "state.json")),
        );
        const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
          state.operations,
        );
        const old = operations.map((operation) => ({
          ...operation,
          steps: operation.steps.map(({ updateSelection: _selection, ...saved }) => saved),
        }));
        const encoded = yield* Schema.encodeEffect(Schema.Array(OperationStatus))(old);
        // An independent pre-fix disk record: keep its batches and progress, remove the new marker.
        const raw = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
        )(yield* fs.readFileString(join(home, "state.json")));
        yield* fs.writeFileString(
          join(home, "state.json"),
          JSON.stringify({ ...raw, operations: encoded }),
        );
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          if (legacy && attempt === 0) {
            assert.strictEqual(library.startup.stopped.length, 1);
            const reason = library.startup.stopped[0]?.reason;
            assert.strictEqual(reason?._tag, "StepFailed");
            if (reason?._tag === "StepFailed")
              assert.strictEqual(reason.error._tag, "Library.UpdateSelectionMissing");
          } else assert.deepStrictEqual(library.startup.stopped, []);
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
        if (boundary === "legacy-backup") {
          assert.isFalse(yield* fs.exists(join(agents, "alpha")));
          if (!backedUpAlpha) return assert.fail("Missing saved Alpha bytes");
          assert.include(yield* fs.readFileString(join(backedUpAlpha, "SKILL.md")), "old");
        } else
          assert.include(
            yield* fs.readFileString(
              join(agents, boundary === "rename" ? "alpha-renamed" : "alpha", "SKILL.md"),
            ),
            boundary === "empty" || boundary === "occupied" || legacy
              ? "old"
              : boundary === "local"
                ? "local choice"
                : "new",
          );
        if (boundary === "occupied") {
          assert.include(yield* fs.readFileString(join(agents, "alpha", "SKILL.md")), "old");
          assert.strictEqual(
            yield* fs.readFileString(join(agents, "alpha-renamed", "SKILL.md")),
            betaBytes,
          );
          assert.strictEqual(
            yield* fs.readFileString(join(agents, "alpha-renamed", ".skit-ownership.json")),
            betaMarker,
          );
        }
        if (boundary === "rename") assert.isFalse(yield* fs.exists(join(agents, "alpha")));
        if (multiple) {
          assert.include(
            yield* fs.readFileString(join(claude, "alpha", "SKILL.md")),
            boundary === "local" ? "local choice" : "new",
          );
          assert.include(yield* fs.readFileString(join(claude, "beta", "SKILL.md")), "old");
        }
      }
      if (legacy) return;
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
